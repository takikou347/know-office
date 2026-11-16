// 戻した直後のデプロイを数えない守りと、自動停止が戻しを飛ばした時の記録 (サービスと拡張の 3.2、自動停止の 3.4)
import { describe, expect, it } from "vitest";
import { connectRollback } from "../../src/gate/guard/deps.ts";
import { collectMetrics, type Analytics } from "../../src/gate/services/deploys.ts";
import { ROLLBACK_COOLDOWN_MS, rollbackService } from "../../src/gate/services/rollback.ts";
import { connect, type Connected, hook } from "../helpers/github.ts";
import { MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

const OFFICE_ID = "00000000-0000-7000-8000-000000000102";
const OFFICE_REPO = "example/know-office";
const STOP_ID = "0192f5c0-0000-7000-8000-0000000000cc";

const sha = (n: number) => n.toString(16).padStart(40, "0");

/**
 * GitHub とつなぎ、know-office を代わりの GitHub のリポジトリに向ける
 * @param w テストの物
 * @returns 連携した結果
 */
async function linked(w: WorkWorld): Promise<Connected> {
  const done = await connect(w);
  await w.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(OFFICE_REPO, OFFICE_ID).run();
  return done;
}

/**
 * task が deploy の本番のデプロイが終わった通知を送る。戻しの workflow が task を付け忘れた時と同じ形
 * @param w テストの物
 * @param link 連携した結果
 * @param id デプロイの ID
 * @returns ゲートウェイの返事
 */
function deployed(w: WorkWorld, link: Connected, id: number): Promise<Response> {
  return hook(w, {
    event: "deployment_status",
    secret: link.webhookSecret,
    payload: {
      action: "created",
      deployment_status: { id: id * 10, state: "success", environment: "production" },
      deployment: { id, sha: sha(id), task: "deploy", environment: "production" },
      repository: { full_name: OFFICE_REPO, default_branch: "main" },
      installation: { id: link.installationId },
    },
  });
}

/**
 * 残った deploy のデプロイの ID
 * @param w テストの物
 * @returns ID の並び
 */
async function deployIds(w: WorkWorld): Promise<unknown[]> {
  const found = await rows(w.d1.DB, "SELECT json_extract(detail, '$.deploymentId') AS id FROM service_events WHERE service_id = ? AND kind = 'deploy' ORDER BY at, rowid", OFFICE_ID);
  return found.map((r) => r["id"]);
}

/**
 * いつも失敗だけを返す、5 分ごとの様子の代わり
 * @returns 様子を読む口
 */
const failing = (): Analytics => ({ read: () => Promise.resolve({ requests: 30, errors: 30, users: 1, reads: 0 }) });

describe("戻した直後のデプロイを数えない", () => {
  it("戻してから 10 分ちょうどまでに届いたデプロイは、task が rollback でなくても deploy にしない", async () => {
    const link = await linked(world);
    await rollbackService(world.gate.env, world.gate.forge, { serviceId: OFFICE_ID, by: "owner", reason: "手で戻す", now: world.clock.now() });
    world.clock.advance(3 * MINUTE);
    await deployed(world, link, 20);
    world.clock.advance(ROLLBACK_COOLDOWN_MS - 3 * MINUTE);
    await deployed(world, link, 21);
    world.clock.advance(1);
    await deployed(world, link, 22);
    expect(await deployIds(world)).toEqual([22]);
  });

  it("戻した直後に残ったデプロイからは、5 分ごとの様子を自動停止に渡さない", async () => {
    await linked(world);
    await rollbackService(world.gate.env, world.gate.forge, { serviceId: OFFICE_ID, by: "owner", reason: "手で戻す", now: world.clock.now() });
    // 前の版が残した、戻しの直後の deploy の行
    const at = world.clock.now() + 2 * MINUTE;
    await world.d1.DB.prepare("INSERT INTO service_events (id, at, service_id, kind, by, detail) VALUES (?, ?, ?, 'deploy', 'system', ?)")
      .bind("0192f5c0-0000-7000-8000-0000000000dd", at, OFFICE_ID, JSON.stringify({ deploymentId: 30, version: "abc1234", commit: sha(30) }))
      .run();
    world.clock.advance(10 * MINUTE);
    await collectMetrics(world.gate.env, failing(), world.clock.now(), world.gate.deps);
    expect(await rows(world.d1.DB, "SELECT id FROM stops WHERE kind = 'stop' AND scope = 'service'")).toEqual([]);
  });
});

describe("自動停止が戻しを飛ばした時", () => {
  it("同じ止めた記録で 2 度目に飛ばした事を、監査ログと通知に 1 つずつ残す", async () => {
    await linked(world);
    const rollback = connectRollback(world.gate.env, world.gate.forge, () => world.clock.now());
    await rollback(OFFICE_ID, STOP_ID);
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'service_rollback_skipped'")).toEqual([]);
    world.clock.advance(30 * MINUTE);
    await rollback(OFFICE_ID, STOP_ID);
    expect(world.gate.audits.filter((a) => a.action === "service.rollback_skipped")).toEqual([expect.objectContaining({ target: OFFICE_ID, actor: "system" })]);
    expect(await rows(world.d1.DB, "SELECT level, kind, scope FROM notices WHERE kind = 'service_rollback_skipped'")).toEqual([{ level: "warn", kind: "service_rollback_skipped", scope: OFFICE_ID }]);
  });

  it("直前に戻していて飛ばした時も残す", async () => {
    await linked(world);
    await rollbackService(world.gate.env, world.gate.forge, { serviceId: OFFICE_ID, by: "owner", reason: "手で戻す", now: world.clock.now() });
    await connectRollback(world.gate.env, world.gate.forge, () => world.clock.now())(OFFICE_ID, STOP_ID);
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'service_rollback_skipped'")).toHaveLength(1);
  });
});
