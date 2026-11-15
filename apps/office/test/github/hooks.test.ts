// GitHub の通知。署名と時刻と配信 ID を確かめ、チェック、プルリクエスト、Issue、App を外した事を受ける (タスクとレビューの 3.5)
import { deliveryId } from "../../dev/github.ts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MINUTE, rows, useWork } from "../helpers/work.ts";
import { type Connected, connect, hook, wrapDb } from "../helpers/github.ts";

const world = useWork();

const UI = "example/knowidea-ui";
const HEAD = "b".repeat(40);
const Problem = z.object({ code: z.string() }).loose();

/**
 * レビューの行を 1 つ置く
 * @returns レビュー ID
 */
async function review(): Promise<string> {
  const id = crypto.randomUUID();
  await world.d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha) VALUES (?, ?, ?, 1, 'ko/x', ?, ?)").bind(id, crypto.randomUUID(), UI, "a".repeat(40), HEAD).run();
  return id;
}

/**
 * レビューのチェックの結果を読む
 * @param id レビュー ID
 * @returns チェックの結果
 */
async function checksOf(id: string): Promise<unknown> {
  const [row] = await rows(world.d1.DB, "SELECT checks FROM reviews WHERE id = ?", id);
  const checks = row?.["checks"];
  return typeof checks === "string" ? z.unknown().parse(JSON.parse(checks)) : null;
}

/**
 * check_run の通知の本文を作る
 * @param c 連携
 * @param name チェックの名前
 * @param conclusion 結果
 * @returns 本文
 */
function checkRun(c: Connected, name: string, conclusion: string | null) {
  return {
    action: conclusion === null ? "created" : "completed",
    check_run: { name, status: conclusion === null ? "in_progress" : "completed", conclusion, head_sha: HEAD },
    repository: { full_name: UI },
    installation: { id: c.installationId },
  };
}

/**
 * issues の opened の通知の本文を作る
 * @param c 連携
 * @param number Issue の番号
 * @returns 本文
 */
function issueOpened(c: Connected, number = 7) {
  return { action: "opened", issue: { number, title: "勤怠の表が崩れる", body: "幅 360 で崩れる" }, repository: { full_name: UI }, installation: { id: c.installationId } };
}

/**
 * 社長の plan のタスクを読む
 * @returns Issue の番号と題
 */
async function planTasks(): Promise<Record<string, unknown>[]> {
  return rows(world.d1.DB, "SELECT issue_number, title FROM nodes WHERE task_kind = 'plan' AND source = 'issue'");
}

describe("通知を受ける", () => {
  it("チェックが終わる", async () => {
    const c = await connect(world);
    const id = await review();
    expect((await hook(world, { event: "check_run", payload: checkRun(c, "verify", "success"), secret: c.webhookSecret })).status).toBe(204);
    expect(await checksOf(id)).toEqual([{ name: "verify", ok: true }]);
    await hook(world, { event: "check_run", payload: checkRun(c, "lint", null), secret: c.webhookSecret });
    await hook(world, { event: "check_run", payload: checkRun(c, "lint", "failure"), secret: c.webhookSecret });
    expect(await checksOf(id)).toEqual([
      { name: "lint", ok: false },
      { name: "verify", ok: true },
    ]);
    // 同じコミットのチェックが走り直す時は、前の結果を消す
    await hook(world, { event: "check_suite", payload: { action: "rerequested", check_suite: { head_sha: HEAD }, repository: { full_name: UI }, installation: { id: c.installationId } }, secret: c.webhookSecret });
    expect(await checksOf(id)).toEqual([]);
  });

  it("プルリクエストに push されたら、レビューの head を新しくし、チェックを消す", async () => {
    const c = await connect(world);
    const id = await review();
    await hook(world, { event: "check_run", payload: checkRun(c, "verify", "success"), secret: c.webhookSecret });
    const next = "c".repeat(40);
    await hook(world, { event: "pull_request", payload: { action: "synchronize", pull_request: { number: 1, head: { sha: next } }, repository: { full_name: UI }, installation: { id: c.installationId } }, secret: c.webhookSecret });
    expect(await rows(world.d1.DB, "SELECT head_sha FROM reviews WHERE id = ?", id)).toEqual([{ head_sha: next }]);
    expect(await checksOf(id)).toEqual([]);
  });

  it("選んだリポジトリの Issue は社長の plan のタスクになる", async () => {
    const c = await connect(world);
    expect((await hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret })).status).toBe(204);
    expect(await planTasks()).toEqual([{ issue_number: 7, title: "勤怠の表が崩れる" }]);
  });
});

describe("なりすましと偽の通知を断る", () => {
  it("偽の通知", async () => {
    const c = await connect(world);
    const id = await review();
    for (const secret of ["not-the-secret-0123456789", ""]) {
      const res = await hook(world, { event: "issues", payload: issueOpened(c), secret });
      expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 401, code: "unauthenticated" });
    }
    const unsigned = await world.gate.app.request("/hooks/v1/github", { method: "POST", body: "{}", headers: { "x-github-event": "issues", "x-github-delivery": deliveryId(world.clock.now()) } }, world.gate.env);
    expect(unsigned.status).toBe(401);
    await hook(world, { event: "check_run", payload: checkRun(c, "verify", "success"), secret: "x".repeat(32) });
    // 社員は動かない
    expect(await planTasks()).toEqual([]);
    expect(await checksOf(id)).toBeNull();
    expect(await rows(world.d1.DB, "SELECT * FROM github_deliveries")).toEqual([]);
  });

  it("同じ通知が 2 度届く", async () => {
    const c = await connect(world);
    const delivery = deliveryId(world.clock.now());
    expect((await hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery })).status).toBe(204);
    expect((await hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery })).status).toBe(204);
    expect(await planTasks()).toEqual([{ issue_number: 7, title: "勤怠の表が崩れる" }]);
    expect(await rows(world.d1.DB, "SELECT event FROM github_deliveries")).toEqual([{ event: "issues" }]);
  });

  it("同じ通知が同時に 2 度届いても 1 度だけ受ける", async () => {
    const c = await connect(world);
    const delivery = deliveryId(world.clock.now());
    const id = await review();
    const sent = await Promise.all([
      hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery }),
      hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery }),
    ]);
    expect(sent.map((r) => r.status)).toEqual([204, 204]);
    expect((await planTasks()).length).toBe(1);
    const run = deliveryId(world.clock.now());
    await Promise.all([1, 2].map(() => hook(world, { event: "check_run", payload: checkRun(c, "verify", "success"), secret: c.webhookSecret, delivery: run })));
    expect(await checksOf(id)).toEqual([{ name: "verify", ok: true }]);
  });

  it("5 分ちょうど前の通知は受け、それより古い通知と先の時刻の通知は捨てる", async () => {
    const c = await connect(world);
    const now = world.clock.now();
    await hook(world, { event: "issues", payload: issueOpened(c, 1), secret: c.webhookSecret, delivery: deliveryId(now - 5 * MINUTE) });
    await hook(world, { event: "issues", payload: issueOpened(c, 2), secret: c.webhookSecret, delivery: deliveryId(now - 5 * MINUTE - 1) });
    await hook(world, { event: "issues", payload: issueOpened(c, 3), secret: c.webhookSecret, delivery: deliveryId(now + 5 * MINUTE + 1) });
    expect((await planTasks()).map((t) => t["issue_number"])).toEqual([1]);
  });

  it("配信 ID が時刻の入った形でなければ 400", async () => {
    const c = await connect(world);
    const res = await hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery: crypto.randomUUID() });
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 400, code: "malformed_request" });
    expect(await planTasks()).toEqual([]);
  });

  it("本文はちょうど 5MB まで受け、超えると 413", async () => {
    const c = await connect(world);
    const base = JSON.stringify({ action: "ping", installation: { id: c.installationId }, pad: "" });
    const padded = (bytes: number) => ({ action: "ping", installation: { id: c.installationId }, pad: "x".repeat(bytes - base.length) });
    expect((await hook(world, { event: "ping", payload: padded(5 * 1024 * 1024), secret: c.webhookSecret })).status).toBe(204);
    const res = await hook(world, { event: "ping", payload: padded(5 * 1024 * 1024 + 1), secret: c.webhookSecret });
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 413, code: "payload_too_large" });
  });

  it("連携していない時と、ほかのインストールの通知は受けない", async () => {
    const before = await hook(world, { event: "issues", payload: { action: "opened" }, secret: "x".repeat(32) });
    expect(before.status).toBe(401);
    const c = await connect(world);
    const other = { ...issueOpened(c), installation: { id: c.installationId + 1 } };
    expect((await hook(world, { event: "issues", payload: other, secret: c.webhookSecret })).status).toBe(204);
    expect(await planTasks()).toEqual([]);
  });

  it("Issue を足すのが途中で落ちたら配信 ID を残さず、届き直しで受ける", async () => {
    const c = await connect(world);
    const delivery = deliveryId(world.clock.now());
    const restore = wrapDb(world, {
      prepare: (real, sql) => {
        if (sql.includes('insert into "nodes"')) throw new Error("D1 に書けない");
        return real(sql);
      },
    });
    const failed = await hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery });
    restore();
    expect(failed.status).toBe(500);
    expect(await rows(world.d1.DB, "SELECT * FROM github_deliveries")).toEqual([]);
    expect((await hook(world, { event: "issues", payload: issueOpened(c), secret: c.webhookSecret, delivery })).status).toBe(204);
    expect((await planTasks()).length).toBe(1);
  });
});
