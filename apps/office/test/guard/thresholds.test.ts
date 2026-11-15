// 基準を守る事。基準を変えると GuardDO に新しいハッシュを渡し、5 分ごとの確かめが settings の最新の行と、それを入れた監査ログの行と比べ、合わなければ全体を止める (自動停止の 3.3)
import { AppError, DEFAULT_THRESHOLDS, newId } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { checkThresholds } from "../../src/gate/guard/observe.ts";
import { thresholdsHash } from "../../src/gate/guard/thresholds.ts";
import { api, MINUTE, rows, type WorkWorld } from "../helpers/work.ts";
import { useWeekly } from "../helpers/weekly.ts";

const world = useWeekly();

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 5 分ごとの確かめを走らせ、全体の止めた記録を返す
 * @returns 全体の止めた記録
 */
async function check(): Promise<Record<string, unknown>[]> {
  await checkThresholds(world.gate.env, world.clock.now(), world.gate.deps);
  return rows(world.d1.DB, "SELECT scope, signal FROM stops WHERE scope = 'office'");
}

/**
 * パスキーで確かめて、基準を 1 つ変える
 * @returns 変えた後の基準のハッシュ
 */
async function change(): Promise<string> {
  await stepUp(world);
  await api(world, "PUT", "/api/v1/guard/thresholds", { version: 0, values: { repeatedFailures: 4 }, reason: "続く失敗を待つ" });
  return thresholdsHash({ ...DEFAULT_THRESHOLDS, repeatedFailures: 4 });
}

/**
 * settings の追記だけの守りを外して基準の値を書き換え、守りを戻す。D1 を直に触られた事にする
 * @param value 書き換える値の JSON の文
 */
async function tamper(value: string): Promise<void> {
  const db = world.d1.DB;
  await db.batch([
    db.prepare("DROP TRIGGER settings_no_update"),
    db.prepare("UPDATE settings SET value = ? WHERE key = 'guard.thresholds'").bind(value),
    db.prepare("CREATE TRIGGER settings_no_update BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'append only'); END"),
  ]);
}

describe("基準を守る", () => {
  it("基準を変えると GuardDO に新しいハッシュを渡し、5 分ごとの確かめは止めない", async () => {
    // 変える前は初期値のまま。GuardDO はまだハッシュを持たない
    expect(await world.gate.office.thresholdHash()).toBeNull();
    expect(await check()).toEqual([]);
    const hash = await change();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await world.gate.office.thresholdHash()).toBe(hash);
    // 監査ログは入れた settings の行を対象にし、同じハッシュを持つ
    const [row] = await rows(world.d1.DB, "SELECT id FROM settings WHERE key = 'guard.thresholds'");
    expect(world.gate.audits.filter((a) => a.action === "guard.thresholds")).toEqual([
      expect.objectContaining({ target: row?.["id"], detail: expect.objectContaining({ version: 1, hash }) as unknown }),
    ]);
    expect(await check()).toEqual([]);
  });

  it("手順を通らずに基準の行が足されていたら、5 分ごとの確かめが全体を止める", async () => {
    await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'guard.thresholds', 'office', ?, 1, 'owner', 'x', ?)")
      .bind(newId(world.clock), JSON.stringify({ ...DEFAULT_THRESHOLDS, staffRuleDenied: 100 }), world.clock.now())
      .run();
    expect(await check()).toEqual([{ scope: "office", signal: "certain_fraud" }]);
  });

  it("入れた後に基準の値を直に書き換えたら、5 分ごとの確かめが全体を止める", async () => {
    await change();
    expect(await check()).toEqual([]);
    await tamper(JSON.stringify({ ...DEFAULT_THRESHOLDS, repeatedFailures: 50 }));
    expect(await check()).toEqual([{ scope: "office", signal: "certain_fraud" }]);
  });

  it("基準の行が読めない値に書き換えられていても、5 分ごとの確かめが全体を止める", async () => {
    await change();
    await tamper("{");
    expect(await check()).toEqual([{ scope: "office", signal: "certain_fraud" }]);
  });

  it("GuardDO のハッシュが入れた基準と違えば全体を止め、確かめ直しても記録は 1 件", async () => {
    await change();
    await world.gate.office.setThresholdHash("0".repeat(64));
    expect(await check()).toEqual([{ scope: "office", signal: "certain_fraud" }]);
    expect(await check()).toEqual([{ scope: "office", signal: "certain_fraud" }]);
  });

  it("初期値のままでも、GuardDO が別のハッシュを持っていれば全体を止める", async () => {
    await world.gate.office.setThresholdHash("0".repeat(64));
    expect(await check()).toEqual([{ scope: "office", signal: "certain_fraud" }]);
  });

  it("形の違うハッシュは GuardDO が断る", async () => {
    await expect(world.gate.office.setThresholdHash("not-a-hash")).rejects.toThrow(AppError);
    expect(await world.gate.office.thresholdHash()).toBeNull();
  });
});
