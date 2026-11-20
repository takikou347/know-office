// 本番にデプロイする口で、デプロイの条件 (deployWhen) を確かめてから deploy.yml を動かす (サービスと拡張の 3.1)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deployService } from "../../src/gate/services/deploy.ts";
import type { Forge } from "../../src/gate/work/loop.ts";
import { connect, type Connected, hook, seedDocsRepo, stepUp } from "../helpers/github.ts";
import { api, idOf, MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

const REPO = "example/know-office";
/** 代わりの GitHub が返す、既定のブランチの先 */
const HEAD = "b".repeat(40);
const DISPATCH = `POST /repos/${REPO}/actions/workflows/deploy.yml/dispatches`;
const CHECK_RUNS = `GET /repos/${REPO}/commits/${HEAD}/check-runs`;

const Problem = z.object({ code: z.string(), detail: z.string() }).loose();
const Accepted = z.object({ id: z.uuid(), status: z.literal("queued") }).strict();

/** liveService がつないだ GitHub。push の通知を署名して送るのに使う */
let link: Connected | null = null;

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
 * 先のコミットについてのレビューの行を置く
 * @param w テストの物
 * @param owner オーナーの判断。無ければ null
 * @returns 置いた行の ID
 */
async function approved(w: WorkWorld, owner: "reject" | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await w.d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, checks, reviewer_verdict, owner_verdict) VALUES (?, ?, ?, 1, 'x', ?, ?, '[]', 'approve', ?)")
    .bind(id, crypto.randomUUID(), REPO, "a".repeat(40), HEAD, owner)
    .run();
  return id;
}

/**
 * サービスの段階の Web アプリを作り、デプロイの条件を決める。サービスに進めるのは初期値 (オーナーの承認だけ) のうちに行う
 * @param w テストの物
 * @param when デプロイの条件。無ければ初期値のまま
 * @returns サービス ID
 */
async function liveService(w: WorkWorld, when?: string[]): Promise<string> {
  await seedDocsRepo(w);
  link = await connect(w);
  const id = idOf(await api(w, "POST", "/api/v1/services", { title: "動画を作るサービス", kind: "web_app", aim: "動画", users: "広報", costEstimateMicroUsd: 1, revenueEstimateMicroUsd: 2 }, 201));
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "study", reason: "調べる" });
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "prototype", reason: "作る", staffId: "builder", repo: REPO });
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "service", reason: "本番に出す" });
  await stepUp(w);
  if (when !== undefined) await api(w, "PUT", `/api/v1/services/${id}/settings/deployWhen`, { version: 0, value: when, reason: "条件を決める" });
  return id;
}

/**
 * 本番にデプロイするルートを呼ぶ
 * @param w テストの物
 * @param id サービス ID
 * @param status 待つステータス
 * @returns 返った物
 */
function deploy(w: WorkWorld, id: string, status = 202): Promise<unknown> {
  return api(w, "POST", `/api/v1/services/${id}/deploy`, undefined, status);
}

/**
 * サービスのリポジトリへ push した通知を送る。本文は送るたびに変え、同じ本文の重ねた通知と見なされないようにする
 * @param w テストの物
 * @param ref push した ref
 * @returns ゲートウェイのステータス
 */
async function pushed(w: WorkWorld, ref = "refs/heads/main"): Promise<number> {
  if (link === null) throw new Error("GitHub をつないでいない");
  const before = crypto.randomUUID().replaceAll("-", "").padEnd(40, "0");
  const res = await hook(w, {
    event: "push",
    secret: link.webhookSecret,
    delivery: crypto.randomUUID(),
    payload: { ref, before, after: HEAD, repository: { full_name: REPO, default_branch: "main" }, installation: { id: link.installationId }, commits: [] },
  });
  return res.status;
}

/**
 * 代わりの GitHub が受けた、deploy.yml を動かす要求
 * @param w テストの物
 * @returns 要求の本文
 */
function dispatched(w: WorkWorld): unknown[] {
  return w.gate.github.requests.filter((r) => r.route === DISPATCH).map((r) => r.body);
}

/**
 * デプロイの錠
 * @param w テストの物
 * @param id サービス ID
 * @returns 錠の行
 */
function deployLock(w: WorkWorld, id: string): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT holder FROM locks WHERE name = ?", `service.deploy:${id}`);
}

/**
 * GitHub のチェックを読む時に、別の書きを挟む口
 * @param w テストの物
 * @param between 挟む書き
 * @returns GitHub を呼ぶ口
 */
function forgeWith(w: WorkWorld, between: () => Promise<unknown>): Forge {
  const real = w.gate.forge;
  return {
    ...real,
    checkState: async (repo, sha) => {
      await between();
      return real.checkState(repo, sha);
    },
  };
}

/**
 * サービスのデプロイの条件の新しい版を、画面の変更と同じ形で直に足す
 * @param w テストの物
 * @param id サービス ID
 * @param version 足す版
 * @param value 値
 */
async function setDeployWhen(w: WorkWorld, id: string, version: number, value: string[]): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO service_settings (id, service_id, key, value, version, by, created_at) VALUES (?, ?, 'deployWhen', ?, ?, 'owner', ?)")
    .bind(crypto.randomUUID(), id, JSON.stringify(value), version, w.clock.now())
    .run();
}

/**
 * office の初期値の新しい版を直に足す
 * @param w テストの物
 * @param version 足す版
 * @param value 値
 */
async function setOfficeDeployWhen(w: WorkWorld, version: number, value: string[]): Promise<void> {
  await w.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'service.deployWhen', 'office', ?, ?, 'owner', '変える', ?)")
    .bind(crypto.randomUUID(), JSON.stringify(value), version, w.clock.now())
    .run();
}

describe("段階ごとのオーナーの判断", () => {
  it("本番にデプロイする時にデプロイの条件を確かめる", async () => {
    const id = await liveService(world, ["checks", "reviewer"]);
    // チェックが終わっておらず、レビュー担当の承認も無ければ、足りない条件を並べて断り、何も動かさない
    checks(world, "pending");
    const lacking = Problem.parse(await deploy(world, id, 409));
    expect(lacking.code).toBe("conflict");
    expect(lacking.detail).toMatch(/足りない条件: checks .*、reviewer /);
    expect(dispatched(world)).toEqual([]);
    expect(await deployLock(world, id)).toEqual([]);
    // そろえば、既定のブランチで、確かめた先のコミットを sha に入れて deploy.yml を 1 回動かす
    checks(world, "passed");
    await approved(world);
    const accepted = Accepted.parse(await deploy(world, id));
    expect(dispatched(world)).toEqual([{ ref: "main", inputs: { sha: HEAD } }]);
    expect(await deployLock(world, id)).toEqual([{ holder: accepted.id }]);
    expect(world.gate.audits).toContainEqual(expect.objectContaining({ action: "service.deploy", target: id }));
  });

  it("main に入った時もデプロイの条件を確かめる", async () => {
    const id = await liveService(world, ["checks", "reviewer"]);
    // 既定のブランチの先のチェックが終わらず、レビュー担当の承認も無ければ、通知は受けるが本番に出さない
    checks(world, "pending");
    expect(await pushed(world)).toBe(204);
    expect(dispatched(world)).toEqual([]);
    expect(await deployLock(world, id)).toEqual([]);
    expect(world.gate.audits.filter((a) => a.action === "service.deploy")).toEqual([]);
    // そろえば、ボタンと同じ口で、確かめた先のコミットを sha に入れて deploy.yml を 1 回動かし、頼んだ事を system の監査ログに残す
    checks(world, "passed");
    await approved(world);
    expect(await pushed(world)).toBe(204);
    expect(dispatched(world)).toEqual([{ ref: "main", inputs: { sha: HEAD } }]);
    const [held] = await deployLock(world, id);
    expect(world.gate.audits.filter((a) => a.action === "service.deploy")).toEqual([
      expect.objectContaining({ actor: "system", target: id, detail: expect.objectContaining({ sha: HEAD, deploymentId: held?.holder }) as unknown }),
    ]);
  });

  describe("main に入った時の境目", () => {
    it("オーナーの承認を求める時は、push では GitHub を読まずに走らせず、ボタンでは走らせる", async () => {
      const id = await liveService(world, ["owner", "checks"]);
      checks(world, "passed");
      const reads = world.gate.github.requests.filter((r) => r.route === CHECK_RUNS).length;
      expect(await pushed(world)).toBe(204);
      expect(world.gate.github.requests.filter((r) => r.route === CHECK_RUNS)).toHaveLength(reads);
      expect(dispatched(world)).toEqual([]);
      await deploy(world, id);
      expect(dispatched(world)).toHaveLength(1);
    });

    it("既定のブランチのほかへの push と、Web アプリでないかサービスか運用の段階でない時は走らせない", async () => {
      const id = await liveService(world, ["checks"]);
      checks(world, "passed");
      expect(await pushed(world, "refs/heads/ko/x")).toBe(204);
      await world.d1.DB.prepare("UPDATE services SET kind = 'content' WHERE id = ?").bind(id).run();
      expect(await pushed(world)).toBe(204);
      await world.d1.DB.prepare("UPDATE services SET kind = 'web_app', stage = 'prototype' WHERE id = ?").bind(id).run();
      expect(await pushed(world)).toBe(204);
      expect(dispatched(world)).toEqual([]);
    });

    it("直前 10 分に頼んでいれば、push では重ねて走らせない", async () => {
      const id = await liveService(world, ["checks"]);
      checks(world, "passed");
      await deploy(world, id);
      world.clock.advance(10 * MINUTE - 1);
      expect(await pushed(world)).toBe(204);
      expect(dispatched(world)).toHaveLength(1);
      world.clock.advance(1);
      expect(await pushed(world)).toBe(204);
      expect(dispatched(world)).toHaveLength(2);
    });

    it("push で workflow を動かせなくても通知は受け、錠を外して次の push で頼める", async () => {
      const id = await liveService(world, ["checks"]);
      checks(world, "passed");
      world.gate.github.failNext(DISPATCH, 404);
      expect(await pushed(world)).toBe(204);
      expect(await deployLock(world, id)).toEqual([]);
      expect(await pushed(world)).toBe(204);
      expect(dispatched(world)).toHaveLength(2);
    });
  });

  it("条件を読んだ後に設定が変わればデプロイしない", async () => {
    const id = await liveService(world, ["checks"]);
    checks(world, "passed");
    // 条件を照らしている間に、オーナーが本番にデプロイする条件を変える
    const forge = forgeWith(world, () => setDeployWhen(world, id, 2, ["checks", "reviewer"]));
    await expect(deployService(world.gate.env, forge, { serviceId: id, now: world.clock.now(), by: "owner" })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("設定が変わった") as unknown });
    expect(dispatched(world)).toEqual([]);
    expect(await deployLock(world, id)).toEqual([]);
  });

  describe("本番にデプロイする条件の境目", () => {
    it("初期値 (オーナーの承認だけ) なら、チェックを読まずに既定のブランチの先を走らせる", async () => {
      const id = await liveService(world);
      world.gate.github.failNext(CHECK_RUNS, 500);
      await deploy(world, id);
      expect(dispatched(world)).toEqual([{ ref: "main", inputs: { sha: HEAD } }]);
    });

    it("受け継いだ初期値を読んだ後に office の初期値が変われば断る", async () => {
      const id = await liveService(world);
      const forge = { ...world.gate.forge, defaultHead: async (repo: string) => (await setOfficeDeployWhen(world, 1, ["owner", "checks"]), world.gate.forge.defaultHead(repo)) };
      await expect(deployService(world.gate.env, forge, { serviceId: id, now: world.clock.now(), by: "owner" })).rejects.toMatchObject({ code: "conflict" });
      expect(dispatched(world)).toEqual([]);
    });

    it("サービスで条件を変えている時は、office の初期値が変わっても断らない", async () => {
      const id = await liveService(world, ["owner"]);
      const forge = { ...world.gate.forge, defaultHead: async (repo: string) => (await setOfficeDeployWhen(world, 1, ["owner", "checks"]), world.gate.forge.defaultHead(repo)) };
      await expect(deployService(world.gate.env, forge, { serviceId: id, now: world.clock.now(), by: "owner" })).resolves.toMatchObject({ status: "queued" });
      expect(dispatched(world)).toHaveLength(1);
    });

    it("確かめた後にオーナーがレビューの承認を断れば、走らせない", async () => {
      const id = await liveService(world, ["checks", "reviewer"]);
      const review = await approved(world);
      checks(world, "passed");
      const forge = forgeWith(world, () => world.d1.DB.prepare("UPDATE reviews SET owner_verdict = 'reject' WHERE id = ?").bind(review).run());
      await expect(deployService(world.gate.env, forge, { serviceId: id, now: world.clock.now(), by: "owner" })).rejects.toMatchObject({ code: "conflict" });
      expect(dispatched(world)).toEqual([]);
    });

    it("読んだ後にリポジトリが変われば断る", async () => {
      const id = await liveService(world, ["checks"]);
      checks(world, "passed");
      const forge = forgeWith(world, () => world.d1.DB.prepare("UPDATE services SET repo = 'example/other' WHERE id = ?").bind(id).run());
      await expect(deployService(world.gate.env, forge, { serviceId: id, now: world.clock.now(), by: "owner" })).rejects.toMatchObject({ code: "conflict" });
      expect(dispatched(world)).toEqual([]);
    });

    it("同時に 2 つ頼んでも、走らせるのは 1 つだけ", async () => {
      const id = await liveService(world);
      const both = await Promise.all([world.gate.request(`/api/v1/services/${id}/deploy`, { method: "POST", headers: world.headers }), world.gate.request(`/api/v1/services/${id}/deploy`, { method: "POST", headers: world.headers })]);
      expect(both.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([202, 409]);
      expect(dispatched(world)).toHaveLength(1);
    });

    it("頼んでから 10 分ちょうどまでは重ねて走らせず、過ぎれば走らせる", async () => {
      const id = await liveService(world);
      await deploy(world, id);
      world.clock.advance(10 * MINUTE - 1);
      const again = Problem.parse(await deploy(world, id, 409));
      expect(again.detail).toContain("直前 10 分");
      expect(again.detail).toContain("設定が変わった");
      world.clock.advance(1);
      await deploy(world, id);
      expect(dispatched(world)).toHaveLength(2);
    });

    it("戻してから 10 分の間は走らせない", async () => {
      const id = await liveService(world);
      await world.d1.DB.prepare("INSERT INTO locks (name, holder, until) VALUES (?, ?, ?)")
        .bind(`service.rollback:${id}`, crypto.randomUUID(), world.clock.now() + 10 * MINUTE)
        .run();
      await deploy(world, id, 409);
      expect(dispatched(world)).toEqual([]);
      expect(await deployLock(world, id)).toEqual([]);
    });

    it("Web アプリでない、リポジトリが無い、サービスか運用の段階でない時は、外へ何も送らずに 409", async () => {
      const id = await liveService(world);
      const set = (column: string, value: string | null) => world.d1.DB.prepare(`UPDATE services SET ${column} = ? WHERE id = ?`).bind(value, id).run();
      await set("kind", "content");
      await deploy(world, id, 409);
      await set("kind", "web_app");
      await set("stage", "prototype");
      await deploy(world, id, 409);
      await set("stage", "operation");
      await set("repo", null);
      await deploy(world, id, 409);
      await deploy(world, "0192f5c0-0000-7000-8000-000000000000", 404);
      expect(dispatched(world)).toEqual([]);
    });

    it("GitHub とつないでいなければ、外へ何も送らずに 409", async () => {
      const id = await liveService(world);
      const forge = { ...world.gate.forge, connected: () => Promise.resolve(false) };
      await expect(deployService(world.gate.env, forge, { serviceId: id, now: world.clock.now(), by: "owner" })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("GitHub と連携していない") as unknown });
      expect(dispatched(world)).toEqual([]);
    });

    it("チェックが落ちていれば、落ちている事が分かる形で断る", async () => {
      const id = await liveService(world, ["checks"]);
      checks(world, "failed");
      expect(Problem.parse(await deploy(world, id, 409)).detail).toContain("チェックが落ちている");
    });

    it("先のコミットかチェックを読めなければ 502 で、錠を残さない", async () => {
      const id = await liveService(world, ["checks"]);
      world.gate.github.failNext(CHECK_RUNS, 500);
      await deploy(world, id, 502);
      expect(await deployLock(world, id)).toEqual([]);
      expect(dispatched(world)).toEqual([]);
    });

    it("workflow を動かせなければ錠を外して 502 にし、次はまた頼める", async () => {
      const id = await liveService(world);
      world.gate.github.failNext(DISPATCH, 404);
      expect(await deploy(world, id, 502)).toMatchObject({ code: "upstream_failed" });
      expect(await deployLock(world, id)).toEqual([]);
      await deploy(world, id);
      expect(dispatched(world)).toHaveLength(2);
    });

    it("GitHub の上限に当たれば 429 で、錠を外す", async () => {
      const id = await liveService(world);
      world.gate.github.failNext(DISPATCH, 429, { "retry-after": "60" });
      expect(await deploy(world, id, 429)).toMatchObject({ code: "rate_limited" });
      expect(await deployLock(world, id)).toEqual([]);
    });

    it("パスキーの確認が無ければ、確かめる前に断る", async () => {
      const id = await liveService(world);
      await world.d1.DB.prepare("UPDATE sessions SET step_up_until = 0").run();
      expect(await deploy(world, id, 401)).toMatchObject({ code: "step_up_required" });
      expect(dispatched(world)).toEqual([]);
    });
  });
});
