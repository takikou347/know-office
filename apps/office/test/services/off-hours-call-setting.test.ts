// 時間外の呼び出しの設定。初期値は閉じ、開く変更と回数を増やす変更はパスキーで確かめる (社員と勤怠の 3.4)
import { newId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, MINUTE, type WorkWorld, useWork } from "../helpers/work.ts";

const world = useWork();

const SettingRow = z.object({ key: z.string(), value: z.unknown(), inherited: z.boolean(), version: z.number() }).strict();

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * office の設定を読み、キーから 1 件への対応にする
 * @param w テストの物
 * @returns キーごとの設定
 */
async function officeSettings(w: WorkWorld): Promise<Record<string, z.infer<typeof SettingRow>>> {
  const rows = z.array(SettingRow).parse(await api(w, "GET", "/api/v1/settings"));
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

describe("オーナーの指示に合わせる", () => {
  const CALL = "/api/v1/settings/workday.offHoursCall";
  const code = z.object({ code: z.string() }).loose();

  it("呼び出しを開くのはパスキーで確かめる", async () => {
    // 初期値は閉じて 1 日 2 回
    expect((await officeSettings(world))["workday.offHoursCall"]).toEqual({ key: "workday.offHoursCall", value: { enabled: false, perDay: 2 }, inherited: true, version: 0 });
    // 開く、閉じたまま回数を増やす、は費用が増えるのでパスキーを求め、書かない
    expect(code.parse(await api(world, "PUT", CALL, { version: 0, value: { enabled: true, perDay: 2 }, reason: "開く" }, 401)).code).toBe("step_up_required");
    expect(code.parse(await api(world, "PUT", CALL, { version: 0, value: { enabled: false, perDay: 3 }, reason: "増やす" }, 401)).code).toBe("step_up_required");
    expect((await officeSettings(world))["workday.offHoursCall"]).toMatchObject({ version: 0 });
    // 減らすのはパスキー無しで通る
    expect(await api(world, "PUT", CALL, { version: 0, value: { enabled: false, perDay: 1 }, reason: "減らす" })).toEqual({ key: "workday.offHoursCall", value: { enabled: false, perDay: 1 }, inherited: false, version: 1 });
    await stepUp(world);
    expect(await api(world, "PUT", CALL, { version: 1, value: { enabled: true, perDay: 3 }, reason: "開く" })).toMatchObject({ value: { enabled: true, perDay: 3 }, version: 2 });
    expect((await officeSettings(world))["workday.offHoursCall"]).toMatchObject({ value: { enabled: true, perDay: 3 }, version: 2 });
    expect(world.gate.audits.filter((a) => a.action === "setting.update").map((a) => a.detail)).toEqual([
      { value: { enabled: false, perDay: 1 }, version: 1, reason: "減らす" },
      { value: { enabled: true, perDay: 3 }, version: 2, reason: "開く" },
    ]);
    // 古い版は断る
    await api(world, "PUT", CALL, { version: 1, value: { enabled: false, perDay: 1 }, reason: "古い版から" }, 409);
    // 閉じるのはパスキー無しで通る
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = 0").run();
    expect(await api(world, "PUT", CALL, { version: 2, value: { enabled: false, perDay: 3 }, reason: "閉じる" })).toMatchObject({ version: 3 });
  });

  it("呼び出しの設定を同じ版から同時に変えると、片方だけが入る", async () => {
    const put = (perDay: number) =>
      world.gate.request(CALL, {
        method: "PUT",
        headers: { ...world.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 0, value: { enabled: false, perDay }, reason: "同時に変える" }),
      });
    const statuses = (await Promise.all([put(1), put(1)])).map((r) => r.status);
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(world.gate.audits.filter((a) => a.action === "setting.update")).toHaveLength(1);
  });

  it("呼び出しの設定の形の違う値を断り、壊れた値は閉じているとみなす", async () => {
    await stepUp(world);
    for (const value of [{ enabled: true, perDay: 0 }, { enabled: true, perDay: 11 }, { enabled: true, perDay: 1.5 }, { enabled: true }, { enabled: true, perDay: 1, extra: 1 }, null]) {
      await api(world, "PUT", CALL, { version: 0, value, reason: "形が違う" }, 422);
    }
    await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'workday.offHoursCall', 'office', ?, 1, 'owner', '壊れた値', ?)")
      .bind(newId(world.clock), JSON.stringify({ enabled: "yes" }), world.clock.now())
      .run();
    expect((await officeSettings(world))["workday.offHoursCall"]).toEqual({ key: "workday.offHoursCall", value: { enabled: false, perDay: 2 }, inherited: false, version: 1 });
  });
});
