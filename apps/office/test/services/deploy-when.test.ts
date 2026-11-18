// サービスに進める時の、デプロイの条件 (deployWhen) の確かめ (サービスと拡張の 3.1)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requireDeployConditions } from "../../src/gate/services/deploy-when.ts";
import { UNCONNECTED_FORGE } from "../../src/gate/work/loop.ts";
import { connect, seedDocsRepo, stepUp } from "../helpers/github.ts";
import { api, idOf, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

const REPO = "example/know-office";
/** 代わりの GitHub が返す、既定のブランチの先 */
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);

const Problem = z.object({ code: z.string(), detail: z.string() }).loose();

/**
 * 既定のブランチの先のチェックを置く
 * @param w テストの物
 * @param run チェックの今
 */
function checks(w: WorkWorld, run: "passed" | "failed" | "pending"): void {
  const status = run === "pending" ? { status: "in_progress", conclusion: null } : { status: "completed", conclusion: run === "passed" ? "success" : "failure" };
  w.gate.github.set(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, { total_count: 1, check_runs: [{ name: "verify", ...status }] });
}

/**
 * 先のコミットについてのレビューの行を、レビュー担当の判断付きで置く
 * @param w テストの物
 * @param verdict レビュー担当の判断
 * @param sha レビューで確かめたコミット
 */
async function reviewed(w: WorkWorld, verdict: "approve" | "reject", sha = HEAD): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, checks, reviewer_verdict) VALUES (?, ?, ?, 1, 'x', ?, ?, '[]', ?)")
    .bind(crypto.randomUUID(), crypto.randomUUID(), REPO, "a".repeat(40), sha, verdict)
    .run();
}

/**
 * 試作の段階のサービスを作り、デプロイの条件を決める
 * @param w テストの物
 * @param when デプロイの条件。無ければ初期値のまま
 * @returns サービス ID
 */
async function prototype(w: WorkWorld, when?: string[]): Promise<string> {
  await seedDocsRepo(w);
  await connect(w);
  const id = idOf(await api(w, "POST", "/api/v1/services", { title: "動画を作るサービス", kind: "web_app", aim: "動画", users: "広報", costEstimateMicroUsd: 1, revenueEstimateMicroUsd: 2 }, 201));
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "study", reason: "調べる" });
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "prototype", reason: "作る", staffId: "builder", repo: REPO });
  if (when !== undefined) {
    await stepUp(w);
    await api(w, "PUT", `/api/v1/services/${id}/settings/deployWhen`, { version: 0, value: when, reason: "条件を決める" });
  }
  return id;
}

/**
 * サービスに進める
 * @param w テストの物
 * @param id サービス ID
 * @param status 待つステータス
 * @returns 返った物
 */
function toService(w: WorkWorld, id: string, status = 200): Promise<unknown> {
  return api(w, "POST", `/api/v1/services/${id}/advance`, { to: "service", reason: "本番に出す" }, status);
}

/**
 * サービスの段階と、段階の出来事と監査ログの数を読む
 * @param w テストの物
 * @param id サービス ID
 * @returns 段階と数
 */
async function stateOf(w: WorkWorld, id: string): Promise<{ stage: unknown; events: number; audits: number }> {
  const [row] = await rows(w.d1.DB, "SELECT stage FROM services WHERE id = ?", id);
  const events = await rows(w.d1.DB, "SELECT 1 FROM service_events WHERE service_id = ? AND kind = 'stage'", id);
  return { stage: row?.["stage"], events: events.length, audits: w.gate.audits.filter((a) => a.action === "service.advance").length };
}

describe("段階ごとのオーナーの判断", () => {
  it("サービスに進める時にデプロイの条件を確かめる", async () => {
    const id = await prototype(world, ["checks", "reviewer"]);
    // チェックがまだ終わっていなければ、足りない条件を返して断る
    checks(world, "pending");
    expect(Problem.parse(await toService(world, id, 409)).detail).toContain("checks");
    // チェックが通っても、レビュー担当の承認が無ければ断る。足りないのは reviewer だけ
    checks(world, "passed");
    const waiting = Problem.parse(await toService(world, id, 409));
    expect(waiting).toMatchObject({ code: "conflict" });
    expect(waiting.detail).toContain("reviewer");
    expect(waiting.detail).not.toContain("checks");
    expect((await stateOf(world, id)).stage).toBe("prototype");
    // 先のコミットをレビュー担当が承認すれば進める
    await reviewed(world, "approve");
    expect(await toService(world, id)).toMatchObject({ id, stage: "service" });
  });

  describe("サービスに進める条件の境目", () => {
    it("初期値 (オーナーの承認だけ) なら GitHub のチェックを読まずに進む", async () => {
      const id = await prototype(world);
      world.gate.github.failNext(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, 500);
      expect(await toService(world, id)).toMatchObject({ stage: "service" });
    });

    it("チェックが落ちていれば、落ちている事が分かる形で断る", async () => {
      const id = await prototype(world, ["checks"]);
      checks(world, "failed");
      expect(Problem.parse(await toService(world, id, 409)).detail).toContain("チェックが落ちている");
    });

    it("レビュー担当の承認が別のコミットの物か、不承認なら足りない", async () => {
      const id = await prototype(world, ["reviewer"]);
      await reviewed(world, "approve", OTHER);
      await reviewed(world, "reject");
      expect(Problem.parse(await toService(world, id, 409)).detail).toContain("reviewer");
    });

    it("足りない時は、段階も出来事も監査ログも変わらない", async () => {
      const id = await prototype(world, ["checks", "reviewer"]);
      const before = await stateOf(world, id);
      checks(world, "failed");
      await toService(world, id, 409);
      expect(await stateOf(world, id)).toEqual(before);
    });

    it("チェックを求める時に GitHub を読めなければ、進めずに 502 を返す", async () => {
      const id = await prototype(world, ["checks"]);
      world.gate.github.failNext(`GET /repos/${REPO}/commits/${HEAD}/check-runs`, 500);
      await toService(world, id, 502);
      expect((await stateOf(world, id)).stage).toBe("prototype");
    });

    it("GitHub とつないでいない間は、チェックかレビュー担当を求めるサービスを断り、オーナーの承認だけなら通す", async () => {
      // ゲートウェイの GitHub の口は連携の後は常につながっているので、つないでいない口を直に渡す
      const id = await prototype(world);
      const service = { id, repo: REPO };
      await expect(requireDeployConditions(world.gate.env, UNCONNECTED_FORGE, service)).resolves.toBeUndefined();
      await stepUp(world);
      await api(world, "PUT", `/api/v1/services/${id}/settings/deployWhen`, { version: 0, value: ["checks"], reason: "チェックで出す" });
      await expect(requireDeployConditions(world.gate.env, UNCONNECTED_FORGE, service)).rejects.toMatchObject({ code: "conflict", message: "GitHub と連携していないので、デプロイの条件 (checks) を確かめられない" });
    });

    it("見送る時は、デプロイの条件を確かめない", async () => {
      const id = await prototype(world, ["checks", "reviewer"]);
      expect(await api(world, "POST", `/api/v1/services/${id}/advance`, { to: "dropped", reason: "やめる" })).toMatchObject({ stage: "dropped" });
    });
  });
});
