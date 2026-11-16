// デプロイの通知と 5 分ごとの様子の読み取りから、service_events の deploy、service_metrics、自動停止の deploy_result を作る。戻しはサービスごとに 1 度だけ動かす (サービスと拡張の 3.2、自動停止の 3.1)
import { describe, expect, it } from "vitest";
import { httpForge } from "../../src/gate/github/forge.ts";
import { type Analytics, collectMetrics, UNCONNECTED_ANALYTICS } from "../../src/gate/services/deploys.ts";
import { rollbackService } from "../../src/gate/services/rollback.ts";
import { connect, type Connected, hook } from "../helpers/github.ts";
import { MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

const UI_ID = "00000000-0000-7000-8000-000000000101";
const OFFICE_ID = "00000000-0000-7000-8000-000000000102";
const UI_REPO = "example/knowidea-ui";
const OFFICE_REPO = "example/know-office";
const DISPATCH = `POST /repos/${OFFICE_REPO}/actions/workflows/rollback.yml/dispatches`;

const sha = (n: number) => n.toString(16).padStart(40, "0");

/**
 * GitHub とつなぎ、最初の 2 つのサービスを代わりの GitHub のリポジトリに向ける
 * @param w テストの物
 * @returns 連携した結果
 */
async function linked(w: WorkWorld): Promise<Connected> {
  const done = await connect(w);
  await w.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(UI_REPO, UI_ID).run();
  await w.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(OFFICE_REPO, OFFICE_ID).run();
  return done;
}

/**
 * 本番のデプロイが終わった通知を送る
 * @param w テストの物
 * @param link 連携した結果
 * @param input デプロイの番号、コミット、種類、環境、状態
 * @param input.id デプロイの ID
 * @param input.commit コミットの番号
 * @param input.task デプロイの task。戻しは rollback
 * @param input.environment 環境
 * @param input.state 状態
 * @param input.delivery 配信 ID
 * @returns ゲートウェイの返事
 */
function deployed(w: WorkWorld, link: Connected, input: { id: number; commit: number; task?: string; environment?: string; state?: string; delivery?: string }): Promise<Response> {
  return hook(w, {
    event: "deployment_status",
    secret: link.webhookSecret,
    ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
    payload: {
      action: "created",
      deployment_status: { id: input.id * 10, state: input.state ?? "success", environment: input.environment ?? "production" },
      deployment: { id: input.id, sha: sha(input.commit), task: input.task ?? "deploy", environment: input.environment ?? "production" },
      repository: { full_name: OFFICE_REPO, default_branch: "main" },
      installation: { id: link.installationId },
    },
  });
}

/**
 * 置いた数を順に返す、5 分ごとの様子の代わり
 * @param answers 順に返す様子
 * @returns 様子を読む口と、読んだ数
 */
function fakeAnalytics(...answers: { requests: number; errors: number }[]): Analytics & { calls: number } {
  const fake = {
    calls: 0,
    read: () => {
      const answer = answers[fake.calls] ?? answers.at(-1) ?? null;
      fake.calls += 1;
      return Promise.resolve(answer === null ? null : { ...answer, users: 3, reads: 0 });
    },
  };
  return fake;
}

async function serviceStops(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT scope, target, signal FROM stops WHERE kind = 'stop' AND scope = 'service'");
}

describe("デプロイを数える", () => {
  it("本番のデプロイの通知で deploy を残し、同じ通知は 1 つにする", async () => {
    const link = await linked(world);
    expect((await deployed(world, link, { id: 7, commit: 1 })).status).toBe(204);
    expect((await deployed(world, link, { id: 7, commit: 1 })).status).toBe(204);
    // 配信 ID だけが違う送り直しも 1 つ
    await deployed(world, link, { id: 7, commit: 1, delivery: "00000000-0000-1000-8000-000000000001" });
    expect(await rows(world.d1.DB, "SELECT kind, by, json_extract(detail, '$.version') AS version FROM service_events WHERE service_id = ? AND kind = 'deploy'", OFFICE_ID)).toEqual([{ kind: "deploy", by: "system", version: sha(1).slice(0, 7) }]);
  });

  it("戻しのデプロイ、本番でない環境、終わっていない状態は deploy にしない", async () => {
    const link = await linked(world);
    await deployed(world, link, { id: 8, commit: 2, task: "rollback" });
    await deployed(world, link, { id: 9, commit: 3, environment: "preview" });
    await deployed(world, link, { id: 10, commit: 4, state: "in_progress" });
    expect(await rows(world.d1.DB, "SELECT id FROM service_events WHERE kind = 'deploy'")).toEqual([]);
  });

  it("ライブラリの公開が組めなければサービスを止める", async () => {
    const link = await linked(world);
    const run = (id: number, conclusion: string, path = ".github/workflows/publish.yml") =>
      hook(world, {
        event: "workflow_run",
        secret: link.webhookSecret,
        payload: {
          action: "completed",
          workflow_run: { id, path, head_branch: "main", head_sha: sha(id), conclusion, status: "completed" },
          repository: { full_name: UI_REPO, default_branch: "main" },
          installation: { id: link.installationId },
        },
      });
    await run(1, "failure", ".github/workflows/check.yml");
    await run(2, "success");
    expect(await serviceStops(world)).toEqual([]);
    expect(await run(3, "failure")).toMatchObject({ status: 204 });
    expect(await serviceStops(world)).toEqual([{ scope: "service", target: UI_ID, signal: "library_build" }]);
    expect(await rows(world.d1.DB, "SELECT json_extract(detail, '$.passed') AS passed FROM service_events WHERE service_id = ? AND kind = 'deploy' ORDER BY at, rowid", UI_ID)).toEqual([{ passed: 1 }, { passed: 0 }]);
  });
});

describe("5 分ごとの様子", () => {
  it("つないでいない間は何も書かず、失敗もしない", async () => {
    await linked(world);
    await collectMetrics(world.gate.env, UNCONNECTED_ANALYTICS, world.clock.now(), world.gate.deps);
    expect(await rows(world.d1.REC_2026, "SELECT id FROM service_metrics")).toEqual([]);
  });

  it("同じ 5 分を 2 度読んでも 1 行で、デプロイの後の返事を 1 度だけ数える", async () => {
    const link = await linked(world);
    await deployed(world, link, { id: 7, commit: 1 });
    // 12 件で 2 件の失敗は、20 件に届かないので延ばす。2 度数えると 24 件で止まる
    const analytics = fakeAnalytics({ requests: 12, errors: 2 }, { requests: 12, errors: 2 }, { requests: 10, errors: 1 });
    world.clock.advance(5 * MINUTE);
    await collectMetrics(world.gate.env, analytics, world.clock.now(), world.gate.deps);
    await collectMetrics(world.gate.env, analytics, world.clock.now(), world.gate.deps);
    expect(await rows(world.d1.REC_2026, "SELECT requests, errors FROM service_metrics WHERE service_id = ?", OFFICE_ID)).toEqual([{ requests: 12, errors: 2 }]);
    expect(await serviceStops(world)).toEqual([]);
    world.clock.advance(5 * MINUTE);
    await collectMetrics(world.gate.env, analytics, world.clock.now(), world.gate.deps);
    expect(await serviceStops(world)).toEqual([{ scope: "service", target: OFFICE_ID, signal: "deploy_failure" }]);
    expect(world.gate.deps.rollbacks).toEqual([OFFICE_ID]);
  });

  it("デプロイからちょうど 10 分までを数え、その後は数えない", async () => {
    const link = await linked(world);
    await deployed(world, link, { id: 7, commit: 1 });
    // 5 分の区切りに合わせる。デプロイは 8 時ちょうど
    const analytics = fakeAnalytics({ requests: 5, errors: 0 }, { requests: 5, errors: 0 }, { requests: 30, errors: 30 });
    const stopsAt: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      world.clock.advance(5 * MINUTE);
      await collectMetrics(world.gate.env, analytics, world.clock.now(), world.gate.deps);
      stopsAt.push((await serviceStops(world)).length);
    }
    expect(stopsAt).toEqual([0, 0, 0]);
    // 15 分の失敗は窓の外なので止めない
    expect(await serviceStops(world)).toEqual([]);
    expect(await rows(world.d1.REC_2026, "SELECT id FROM service_metrics WHERE service_id = ?", OFFICE_ID)).toHaveLength(3);
  });

  it("戻しのデプロイの後の返事では止めない", async () => {
    const link = await linked(world);
    await deployed(world, link, { id: 8, commit: 2, task: "rollback" });
    world.clock.advance(5 * MINUTE);
    await collectMetrics(world.gate.env, fakeAnalytics({ requests: 30, errors: 30 }), world.clock.now(), world.gate.deps);
    expect(await serviceStops(world)).toEqual([]);
  });
});

describe("戻しを 1 度にする", () => {
  it("同じ止めた記録で 2 度戻しても、送るのは 1 度", async () => {
    await linked(world);
    const forge = world.gate.forge;
    const first = await rollbackService(world.gate.env, forge, { serviceId: OFFICE_ID, by: "system", reason: "deploy_failure", stopId: "0192f5c0-0000-7000-8000-0000000000aa", now: world.clock.now() });
    expect(first?.status).toBe("queued");
    world.clock.advance(30 * MINUTE);
    expect(await rollbackService(world.gate.env, forge, { serviceId: OFFICE_ID, by: "system", reason: "deploy_failure", stopId: "0192f5c0-0000-7000-8000-0000000000aa", now: world.clock.now() })).toBeNull();
    expect(world.gate.github.requests.filter((r) => r.route === DISPATCH)).toHaveLength(1);
  });

  it("直前に戻していれば、ほかの止めた記録でも戻さない", async () => {
    await linked(world);
    const forge = world.gate.forge;
    await rollbackService(world.gate.env, forge, { serviceId: OFFICE_ID, by: "owner", reason: "手で戻す", now: world.clock.now() });
    world.clock.advance(9 * MINUTE);
    expect(await rollbackService(world.gate.env, forge, { serviceId: OFFICE_ID, by: "system", reason: "deploy_failure", stopId: "0192f5c0-0000-7000-8000-0000000000bb", now: world.clock.now() })).toBeNull();
    expect(world.gate.github.requests.filter((r) => r.route === DISPATCH)).toHaveLength(1);
  });

  it("同時に 2 つ手で戻すと、送るのは 1 度で、片方は 409", async () => {
    await linked(world);
    const forge = world.gate.forge;
    const both = await Promise.allSettled([0, 1].map(() => rollbackService(world.gate.env, forge, { serviceId: OFFICE_ID, by: "owner", reason: "手で戻す", now: world.clock.now() })));
    expect(both.map((b) => b.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(both.find((b) => b.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    expect(world.gate.github.requests.filter((r) => r.route === DISPATCH)).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT id FROM service_events WHERE kind = 'rollback'")).toHaveLength(1);
  });

  it("送れた後に記録を書けなければ、エラーログと通知に残す", async () => {
    await linked(world);
    const env = world.gate.env;
    const real = env.DB;
    let failed = false;
    // 戻しを送った後の batch だけを落とす
    env.DB = new Proxy(real, {
      get(target, prop): unknown {
        const value: unknown = Reflect.get(target, prop);
        if (prop === "batch" && !failed) {
          return () => {
            failed = true;
            return Promise.reject(new Error("D1 が落ちた"));
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await rollbackService(env, world.gate.forge, { serviceId: OFFICE_ID, by: "owner", reason: "手で戻す", now: world.clock.now() });
    } finally {
      env.DB = real;
    }
    expect(world.gate.github.requests.filter((r) => r.route === DISPATCH)).toHaveLength(1);
    expect(await rows(real, "SELECT kind, level FROM notices WHERE kind = 'service_rollback_unrecorded'")).toEqual([{ kind: "service_rollback_unrecorded", level: "warn" }]);
    expect(await rows(world.d1.REC_2026, "SELECT code FROM error_events WHERE code = 'service_rollback_unrecorded'")).toHaveLength(1);
  });
});

describe("外へ出ない", () => {
  it("戻しの送り先が本物の GitHub なら、テストの外への fetch が断り、届かない", async () => {
    await linked(world);
    const forge = httpForge("https://api.github.com", world.gate.fetch, { appId: 1, token: () => Promise.resolve("ghs_test") });
    await expect(forge.dispatchWorkflow(OFFICE_REPO, "rollback.yml", { reason: "戻す" })).rejects.toMatchObject({ code: "upstream_failed" });
    // 形の違う workflow の名前は道に入れない
    await expect(world.gate.forge.dispatchWorkflow(OFFICE_REPO, "../x.yml", { reason: "戻す" })).rejects.toMatchObject({ code: "internal" });
    expect(world.gate.github.requests.filter((r) => r.route.includes("/dispatches"))).toEqual([]);
  });
});
