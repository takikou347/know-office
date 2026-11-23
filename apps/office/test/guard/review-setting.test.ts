// レビュー担当に止めた記録を聞く設定。初期値は閉じ、開く変更と回数を増やす変更はパスキーで確かめる (自動停止の 3.5)
import { newId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, MINUTE, useWork } from "../helpers/work.ts";

const world = useWork();

const SettingRow = z.object({ key: z.string(), value: z.unknown(), inherited: z.boolean(), version: z.number() }).strict();
const KEY = "guard.review";
const PATH = `/api/v1/settings/${KEY}`;
const code = z.object({ code: z.string() }).loose();

/**
 * レビュー担当に聞く設定を一覧から読む
 * @returns 設定
 */
async function current(): Promise<z.infer<typeof SettingRow> | undefined> {
  return z
    .array(SettingRow)
    .parse(await api(world, "GET", "/api/v1/settings"))
    .find((r) => r.key === KEY);
}

describe("再開", () => {
  it("レビュー担当に聞く設定を開くのはパスキーで確かめる", async () => {
    // 初期値は閉じて 1 日 10 回。一覧では会話の言葉の指示の次、月の予算と基準の前に出る
    const keys = z
      .array(SettingRow)
      .parse(await api(world, "GET", "/api/v1/settings"))
      .map((r) => r.key);
    expect(keys.slice(0, 6)).toEqual(["workday.schedule", "workday.offHoursCall", "workday.chatOrders", KEY, "claude.budget", "guard.thresholds"]);
    expect(await current()).toEqual({ key: KEY, value: { enabled: false, perDay: 10 }, inherited: true, version: 0 });
    expect(code.parse(await api(world, "PUT", PATH, { version: 0, value: { enabled: true, perDay: 10 }, reason: "開く" }, 401)).code).toBe("step_up_required");
    expect(code.parse(await api(world, "PUT", PATH, { version: 0, value: { enabled: false, perDay: 11 }, reason: "増やす" }, 401)).code).toBe("step_up_required");
    expect(await api(world, "PUT", PATH, { version: 0, value: { enabled: false, perDay: 5 }, reason: "減らす" })).toEqual({ key: KEY, value: { enabled: false, perDay: 5 }, inherited: false, version: 1 });
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now() + 15 * MINUTE).run();
    expect(await api(world, "PUT", PATH, { version: 1, value: { enabled: true, perDay: 5 }, reason: "開く" })).toMatchObject({ value: { enabled: true, perDay: 5 }, version: 2 });
    expect(world.gate.audits.filter((a) => a.action === "setting.update").map((a) => a.target)).toEqual([KEY, KEY]);
  });

  it("レビュー担当に聞く設定の形の違う値を断り、壊れた値は閉じているとみなす", async () => {
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now() + 15 * MINUTE).run();
    for (const value of [{ enabled: true, perDay: 0 }, { enabled: true, perDay: 51 }, { enabled: true }, { enabled: true, perDay: 1, extra: 1 }, null]) {
      await api(world, "PUT", PATH, { version: 0, value, reason: "形が違う" }, 422);
    }
    await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, ?, 'office', ?, 1, 'owner', '壊れた値', ?)")
      .bind(newId(world.clock), KEY, JSON.stringify({ enabled: "yes" }), world.clock.now())
      .run();
    expect(await current()).toEqual({ key: KEY, value: { enabled: false, perDay: 10 }, inherited: false, version: 1 });
  });
});
