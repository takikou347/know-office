// App の鍵。GitHub を呼ぶたびに、リポジトリ 1 つと要る権限だけに絞った 1 時間の鍵をゲートウェイが作って付ける (タスクとレビューの 3.3)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MINUTE, rows, useWork } from "../helpers/work.ts";
import { connect, fromWorkspace, push, startTask, stepUp } from "../helpers/github.ts";

const world = useWork();

const UI = "example/knowidea-ui";
const OFFICE = "example/know-office";
const Problem = z.object({ code: z.string() }).loose();

/**
 * 代わりの GitHub が出した鍵を、出した順に並べる
 * @returns 届くリポジトリ、権限、期限
 */
function minted() {
  return [...world.gate.github.tokens.values()];
}

/**
 * 代わりの GitHub の git の受け口に届いた要求
 * @returns 「メソッド パス」
 */
function gitRequests(): string[] {
  return world.gate.github.requests.filter((r) => r.route.includes(".git/")).map((r) => r.route);
}

/**
 * ワークスペースから api.github.com を呼ぶ
 * @param work 送る社員と作業トークン
 * @param work.staffId 社員 ID
 * @param work.token 作業トークン
 * @param method メソッド
 * @param path 道
 * @returns 受け手の返事
 */
function api(work: { staffId: "builder"; token: string }, method: string, path: string): Promise<Response> {
  return fromWorkspace(world, work, new Request(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${work.token}` }, ...(method === "GET" ? {} : { body: "{}" }) }));
}

describe("App の鍵", () => {
  it("絞った鍵", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/0190f4a8-attendance" }]);
    expect({ status: res.status, body: await res.text() }).toEqual({ status: 200, body: "fake-git" });
    // knowidea-ui だけに書ける、1 時間の鍵
    expect(minted()).toEqual([{ installationId: expect.any(Number) as unknown, repos: [UI], permissions: { contents: "write" }, expiresAt: world.clock.now() + 60 * MINUTE }]);
    const sent = world.gate.github.requests.filter((r) => r.route === `POST /${UI}.git/git-receive-pack`);
    expect(sent.map((r) => r.token)).toEqual([[...world.gate.github.tokens.keys()][0]]);
    // ワークスペースに GitHub の鍵を返さない
    expect(sent[0]?.token).not.toBe(work.token);
    expect(world.gate.audits.filter((a) => a.action === "github.push")).toEqual([
      expect.objectContaining({ actor: "builder", target: UI, detail: { nodeId: work.nodeId, refs: ["refs/heads/ko/0190f4a8-attendance"] } }),
    ]);
  });

  it("選んでいないリポジトリ", async () => {
    await connect(world);
    // インストールで選んでいないリポジトリ。鍵を作る時に GitHub が断る
    const outside = await startTask(world, "example/private-notes");
    const res = await push(world, outside, "example/private-notes", [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    // 触れるリポジトリを knowidea-ui に絞ると、know-office は鍵を作る前に断る
    await stepUp(world);
    // 非公開なのでルールセットは掛けない
    world.gate.github.set(`GET /repos/${UI}`, { private: true, default_branch: "main" });
    const put = await world.gate.request("/api/v1/github/rules", { method: "PUT", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: 0, repos: [UI], reason: "knowidea-ui だけ" }) });
    expect(put.status).toBe(200);
    const before = minted().length;
    const office = await startTask(world, OFFICE, "reviewer");
    const denied = await push(world, office, OFFICE, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: denied.status, code: Problem.parse(await denied.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(minted().length).toBe(before);
    expect(gitRequests()).toEqual([]);
    const read = await api({ staffId: "builder", token: outside.token }, "GET", `/repos/${OFFICE}/pulls`);
    expect(read.status).toBe(403);
  });

  it("ワークスペースからの api.github.com は選んだリポジトリへの GET を、読む鍵で通す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.set(`GET /repos/${UI}/pulls`, [{ number: 1 }]);
    const read = await api({ staffId: "builder", token: work.token }, "GET", `/repos/${UI}/pulls`);
    expect({ status: read.status, body: z.unknown().parse(await read.json()) }).toEqual({ status: 200, body: [{ number: 1 }] });
    expect(minted().at(-1)).toMatchObject({ repos: [UI], permissions: { pull_requests: "read" } });
  });
  it("同じ組の鍵は 50 分ためる", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const fetchRefs = () =>
      fromWorkspace(world, work, new Request(`https://github.com/${UI}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`x-access-token:${work.token}`)}` } }));
    expect((await fetchRefs()).status).toBe(200);
    world.clock.advance(50 * MINUTE - 1);
    await world.gate.staff.builder.book.heartbeat(world.clock.now());
    expect((await fetchRefs()).status).toBe(200);
    expect(minted().length).toBe(1);
    world.clock.advance(1);
    expect((await fetchRefs()).status).toBe(200);
    expect(minted().length).toBe(2);
  });

  it("失効した作業トークンでは push できない", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    await world.gate.staff.builder.guard.revokeTokens([work.jti]);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect(res.status).toBe(401);
    expect(minted()).toEqual([]);
  });

  it("連携していない時は鍵を作らず断る", async () => {
    const work = await startTask(world, UI);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
    expect(await rows(world.d1.DB, "SELECT name FROM vault WHERE name LIKE 'github_%'")).toEqual([]);
  });
});

describe("ゲートウェイが断る GitHub の操作", () => {
  const cases = [
    { name: "main への push", repo: UI, updates: [{ ref: "refs/heads/ko/ok" }, { ref: "refs/heads/main" }] },
    { name: "ブランチを消す push", repo: UI, updates: [{ ref: "refs/heads/ko/old", from: "d".repeat(40), to: "0".repeat(40) }] },
    { name: "タグの push", repo: UI, updates: [{ ref: "refs/tags/v1" }] },
    { name: "タスクのでないリポジトリへの push", repo: OFFICE, updates: [{ ref: "refs/heads/ko/x" }] },
  ];
  it.each(cases)("$name", async (c) => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await push(world, work, c.repo, c.updates);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(gitRequests()).toEqual([]);
    expect(minted()).toEqual([]);
    // ルールの外の操作として数え、そのタスクを止める
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", work.nodeId)).toEqual([{ status: "stopped" }]);
  });

  const writes = [
    { name: "api.github.com に書く", method: "POST", path: `/repos/${UI}/pulls` },
    { name: "api.github.com のリポジトリの外を読む", method: "GET", path: "/user" },
  ];
  it.each(writes)("$name", async ({ method, path }) => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await api({ staffId: "builder", token: work.token }, method, path);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(minted()).toEqual([]);
  });
});
