// 想定外の失敗をエラーログに残す事を確かめる。ログインと記録の 3.8
import { Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

// テストごとに空の D1 を作り、前のテストが書いた行に頼らない
let d1: TestD1;
let gate: TestGate;
let signedIn: Record<string, string>;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock, d1 });
  // 投げる文は要求ごとにクエリの m で変える。投げる場所 (fingerprint) は同じ
  gate.app.get("/api/v1/boom", (c) => {
    throw new TypeError(c.req.query("m") ?? "");
  });
  signedIn = await gate.signIn();
});
afterEach(() => d1.dispose());

const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));

/**
 * わざと落ちるルートを呼ぶ
 * @param message 投げるエラーの文
 * @param env バインディングを差し替える時に渡す
 * @returns 返事
 */
function boom(message: string, env = gate.env): Promise<Response> {
  return Promise.resolve(gate.app.request(`/api/v1/boom?m=${encodeURIComponent(message)}`, { headers: signedIn }, env));
}

const rows = async () =>
  (await d1.REC_2026.prepare("SELECT source, level, code, message, route, status, fingerprint, trace_id FROM error_events ORDER BY rowid").all()).results;

describe("エラーログ", () => {
  it("500 で error_events に 1 行足し、鍵や中身を残さない", async () => {
    const res = await boom("接続に失敗 secret=abc123 token: ghs_XYZ");
    expect(res.status).toBe(500);
    const body = Problem.parse(await res.json());
    const [row] = await rows();
    expect(row).toMatchObject({ source: "gate", level: "error", code: "internal", route: "/api/v1/boom", status: 500, trace_id: body.traceId });
    expect(String(row?.["message"])).toContain("TypeError");
    expect(String(row?.["message"])).not.toMatch(/abc123|ghs_XYZ/);
  });

  it("同じ原因は同じ fingerprint にまとまる", async () => {
    await boom("1 回目");
    await boom("2 回目");
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all[1]?.["fingerprint"]).toBe(all[0]?.["fingerprint"]);
  });

  it("同じ原因が 5 分に 3 回を超えると知らせを出す", async () => {
    for (let n = 1; n <= 3; n += 1) await boom("また");
    expect((await d1.DB.prepare("SELECT kind FROM notices").all()).results).toEqual([]);
    // 4 回目で 1 つ、5 回目では増えない
    await boom("また");
    await boom("また");
    const notices = await d1.DB.prepare("SELECT level, kind FROM notices").all();
    expect(notices.results).toEqual([{ level: "warn", kind: "error_burst" }]);
  });

  it("エラーログに書けなくても返事は変わらない", async () => {
    const res = await boom("書けない", { ...gate.env, REC_2026: undefined });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "internal", detail: "想定外のエラーが起きた" });
  });
});
