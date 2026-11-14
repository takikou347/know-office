// 監査ログのハッシュチェーンを確かめる。データの 3.3、ログインと記録の 3.4
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, GENESIS_HASH, verifyChain } from "../../src/gate/records/audit.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
});
afterAll(() => d1.dispose());

const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
const entry = (action: string) => ({ at: clock.now(), actor: "owner", action, target: "s1", scope: "office", detail: { n: 1 }, traceId: "a".repeat(32) });

describe("監査ログ", () => {
  it("最初の行は 0 が 64 個の prev_hash から始まり、行ごとに前のハッシュでつながる", async () => {
    const first = await appendAudit(d1.REC_2026, GENESIS_HASH, entry("session.create"), clock);
    const second = await appendAudit(d1.REC_2026, first.hash, entry("session.end"), clock);
    const rows = await d1.REC_2026.prepare("SELECT id, prev_hash, hash FROM audit_log ORDER BY rowid").all<{ id: string; prev_hash: string; hash: string }>();
    expect(rows.results).toEqual([
      { id: first.id, prev_hash: GENESIS_HASH, hash: first.hash },
      { id: second.id, prev_hash: first.hash, hash: second.hash },
    ]);
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toEqual({ ok: true, brokenAt: null, lastHash: second.hash });
  });

  it("記録が書き換わるとハッシュチェーンが合わなくなる", async () => {
    const { results } = await d1.REC_2026.prepare("SELECT id FROM audit_log ORDER BY rowid").all<{ id: string }>();
    // 書き換えはトリガーが断るので、トリガーを外して書き換えた事にする
    await d1.REC_2026.prepare("DROP TRIGGER audit_log_no_update").run();
    await d1.REC_2026.prepare("UPDATE audit_log SET detail = '{\"n\":2}' WHERE id = ?").bind(results[0]?.id).run();
    expect(await verifyChain(d1.REC_2026, GENESIS_HASH)).toMatchObject({ ok: false, brokenAt: results[0]?.id });
  });
});
