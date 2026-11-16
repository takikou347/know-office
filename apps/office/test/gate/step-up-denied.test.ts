// パスキーの確認が無くて断った変更を監査ログに残す。誰かが守りを弱めようとして断られた事を後から追える (ログインと記録の 3.3)
import { describe, expect, it } from "vitest";
import { api, MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/**
 * 今のログインセッションの ID を読む
 * @param w テストの物
 * @returns セッション ID
 */
async function sessionId(w: WorkWorld): Promise<string> {
  const [row] = await rows(w.d1.DB, "SELECT id FROM sessions WHERE ended_at IS NULL");
  return String(row?.["id"]);
}

const denied = (w: WorkWorld) => w.gate.audits.filter((a) => a.action === "step_up.denied");

describe("大事な操作の前にパスキーで確かめる", () => {
  // 守りを弱める設定の変更を断ると、ルート、変えようとした項目、ログインセッションを残す
  it("確かめずに変えようとして断られる", async () => {
    await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 0, value: [], reason: "弱める" }, 401);
    expect(denied(world)).toEqual([
      expect.objectContaining({
        actor: "owner",
        target: "service.protectedPaths",
        detail: { method: "PUT", route: "/api/v1/settings/:key", params: { key: "service.protectedPaths" }, sessionId: await sessionId(world) },
      }),
    ]);
  });

  it("2 本目のパスキーの追加を断ると残す", async () => {
    await world.d1.DB.prepare("INSERT INTO passkeys (id, credential_id, public_key, counter, transports, created_at) VALUES ('0190f4a8-0000-7000-8000-000000000001', 'cred', 'key', 0, '[]', ?)")
      .bind(world.clock.now())
      .run();
    await api(world, "POST", "/api/v1/passkeys", { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "x", attestationObject: "x" }, clientExtensionResults: {} }, 401);
    expect(denied(world)).toMatchObject([{ target: null, detail: { method: "POST", route: "/api/v1/passkeys", params: {} } }]);
  });

  it("入力を確かめる前に断るルートも残す", async () => {
    await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: {}, reason: "弱める" }, 401);
    expect(denied(world)).toMatchObject([{ detail: { route: "/api/v1/guard/thresholds" } }]);
  });

  it("確かめた後に通った変更と、確認の要らない変更は残さない", async () => {
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" });
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now() + 15 * MINUTE).run();
    await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 0, value: [], reason: "弱める" });
    expect(denied(world)).toEqual([]);
  });

  it("本文は残さず、パスの値だけを残す", async () => {
    await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 0, value: [], reason: "秘密の理由" }, 401);
    expect(JSON.stringify(denied(world))).not.toContain("秘密の理由");
  });

  it("パスキーの確認と違う理由で断った時は残さない", async () => {
    await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 5, value: [], reason: "古い版" }, 409);
    await api(world, "PUT", "/api/v1/settings/no.such", { version: 0, value: [], reason: "無い項目" }, 404);
    expect(denied(world)).toEqual([]);
  });

  it("ログインセッションの無い要求は残さない", async () => {
    const res = await world.gate.request("/api/v1/guard/thresholds", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(denied(world)).toEqual([]);
  });

  it("監査ログに書けなくても 401 のまま返し、エラーログに残す", async () => {
    const real = world.gate.env.RECORDER;
    // 記録 DO の代わりは append だけを持つ
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    world.gate.env.RECORDER = { idFromName: () => "recorder", get: () => ({ append: () => Promise.reject(new Error("記録 DO に届かない")) }) } as unknown as typeof real;
    try {
      expect(await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 0, value: [], reason: "弱める" }, 401)).toMatchObject({ code: "step_up_required" });
    } finally {
      world.gate.env.RECORDER = real;
    }
    expect(await rows(world.d1.REC_2026, "SELECT level, code FROM error_events")).toEqual([{ level: "warn", code: "step_up_denied_audit_failed" }]);
  });
});
