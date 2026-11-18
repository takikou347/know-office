// オーナーがレビューで書き換えた 1 ファイルを、ゲートウェイが Git の API で同じブランチにコミットする (タスクとレビューの 3.2、要件 review のその場で直す)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, REPO, rows, useWork } from "../helpers/work.ts";
import { HEAD, openReview } from "../helpers/review.ts";

/** 読んだ先の木。代わりの GitHub は、知らないコミットの木を sha を逆に並べた物にする */
const TREE = HEAD.split("").toReversed().join("");
const SRC = "d".repeat(40);
const KNOW_IDEA = { name: "KNOW IDEA", email: "noreply@knowidea.invalid" };

/**
 * 代わりの GitHub が受けたコミットを作る要求の本文
 * @returns 本文
 */
function commitBodies(): unknown[] {
  return world.gate.github.requests.filter((r) => r.route === `POST /repos/${REPO}/git/commits`).map((r) => r.body);
}

/**
 * 代わりの GitHub が受けた木を作る要求の、書き換えた項目
 * @returns 項目
 */
function treeEntries(): unknown[] {
  return world.gate.github.requests.filter((r) => r.route === `POST /repos/${REPO}/git/trees`).flatMap((r) => z.object({ tree: z.array(z.unknown()) }).loose().parse(r.body).tree);
}

const world = useWork();

const CHANGE = { path: "src/attendance.ts", content: "export const empty = 0;\n", baseSha: HEAD, message: "空の日は 0 を出す" };

/**
 * 代わりの GitHub が受けた Git の API の要求の道
 * @returns 「メソッド パス」
 */
function gitRoutes(): string[] {
  return world.gate.github.requests.filter((r) => r.route.includes("/git/")).map((r) => r.route);
}

describe("その場で直す", () => {
  it("直してコミットする", async () => {
    const { task } = await openReview(world);
    const branch = z.object({ branch: z.string() }).parse((await rows(world.d1.DB, "SELECT branch FROM reviews WHERE node_id = ?", task))[0]).branch;
    world.gate.github.heads.set(`${REPO}:${branch}`, HEAD);
    const res = await world.gate.request(`/api/v1/reviews/${task}/commits`, { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify(CHANGE) });
    expect(res.status).toBe(201);
    const { sha } = z.object({ data: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) }).loose().parse(await res.json()).data;
    expect(res.headers.get("Location")).toBe(`/api/v1/reviews/${task}/commits/${sha}`);
    expect(gitRoutes()).toEqual([`GET /repos/${REPO}/git/commits/${HEAD}`, `GET /repos/${REPO}/git/trees/${TREE}`, `POST /repos/${REPO}/git/blobs`, `POST /repos/${REPO}/git/trees`, `POST /repos/${REPO}/git/commits`, `PATCH /repos/${REPO}/git/refs/heads/${branch}`]);
    expect(world.gate.github.heads.get(`${REPO}:${branch}`)).toBe(sha);
    // 変更の表示は新しい先から読み直す
    expect(await rows(world.d1.DB, "SELECT head_sha, checks FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: sha, checks: "[]" }]);
    expect(world.gate.audits.find((a) => a.action === "review.commit")).toMatchObject({ actor: "owner", target: task, detail: { repo: REPO, sha, path: CHANGE.path } });
  });

  it("直してコミットすると先が進むので、オーナーとレビュー担当の承認を消して待ち直す", async () => {
    const { task } = await openReview(world);
    const branch = z.object({ branch: z.string() }).parse((await rows(world.d1.DB, "SELECT branch FROM reviews WHERE node_id = ?", task))[0]).branch;
    world.gate.github.heads.set(`${REPO}:${branch}`, HEAD);
    await world.d1.DB.prepare("UPDATE reviews SET owner_verdict = 'approve', reviewer_verdict = 'approve' WHERE node_id = ?").bind(task).run();
    const { sha } = z.object({ sha: z.string() }).parse(await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 201));
    expect(await rows(world.d1.DB, "SELECT head_sha, owner_verdict, reviewer_verdict FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: sha, owner_verdict: null, reviewer_verdict: null }]);
  });

  it("触れない所を書き換えるコミットは 403 で断る", async () => {
    const { task } = await openReview(world);
    expect(await api(world, "POST", `/api/v1/reviews/${task}/commits`, { ...CHANGE, path: ".github/workflows/ci.yml" }, 403)).toMatchObject({ code: "rule_denied" });
    expect(gitRoutes()).toEqual([]);
  });

  it("確かめた後に変更が足されていたら 409 で断る", async () => {
    const { task } = await openReview(world);
    expect(await api(world, "POST", `/api/v1/reviews/${task}/commits`, { ...CHANGE, baseSha: "c".repeat(40) }, 409)).toMatchObject({ code: "conflict" });
    expect(gitRoutes()).toEqual([]);
  });

  it("GitHub の側でブランチが進んでいたら 409 で断り、先を変えない", async () => {
    const { task } = await openReview(world);
    const branch = z.object({ branch: z.string() }).parse((await rows(world.d1.DB, "SELECT branch FROM reviews WHERE node_id = ?", task))[0]).branch;
    world.gate.github.heads.set(`${REPO}:${branch}`, "e".repeat(40));
    expect(await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 409)).toMatchObject({ code: "conflict" });
    expect(world.gate.github.heads.get(`${REPO}:${branch}`)).toBe("e".repeat(40));
    expect(await rows(world.d1.DB, "SELECT head_sha FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: HEAD }]);
  });

  it("コミットには contents の書きだけに絞った鍵を付ける", async () => {
    const { task } = await openReview(world);
    await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 201);
    const writes = world.gate.github.requests.filter((r) => r.route.startsWith(`POST /repos/${REPO}/git/`));
    expect(writes).toHaveLength(3);
    for (const r of writes) {
      const t = world.gate.github.tokens.get(r.token ?? "");
      expect(t?.repos).toEqual([REPO]);
      expect(t?.permissions).toEqual({ contents: "write" });
    }
  });

  it("コミットの作者と入れた者は KNOW IDEA にする", async () => {
    const { task } = await openReview(world);
    await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 201);
    const [body] = commitBodies();
    expect(body).toMatchObject({ message: CHANGE.message, parents: [HEAD], author: KNOW_IDEA, committer: KNOW_IDEA });
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(body)).toSorted()).toEqual(["author", "committer", "message", "parents", "tree"]);
  });

  it("書き換えるファイルの mode を引き継ぐ", async () => {
    const { task } = await openReview(world);
    world.gate.github.trees.set(TREE, [{ path: "src", mode: "040000", type: "tree", sha: SRC }]);
    world.gate.github.trees.set(SRC, [{ path: "attendance.ts", mode: "100755", type: "blob", sha: "e".repeat(40) }]);
    await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 201);
    expect(treeEntries()).toMatchObject([{ path: CHANGE.path, mode: "100755", type: "blob" }]);
  });

  it("新しいファイルは 100644 で足す", async () => {
    const { task } = await openReview(world);
    world.gate.github.trees.set(TREE, [{ path: "src", mode: "040000", type: "tree", sha: SRC }]);
    world.gate.github.trees.set(SRC, []);
    await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 201);
    expect(treeEntries()).toMatchObject([{ path: CHANGE.path, mode: "100644", type: "blob" }]);
  });

  it("シンボリックリンクとサブモジュールを書き換えるコミットは 403 で断る", async () => {
    const { task } = await openReview(world);
    for (const [mode, type] of [["120000", "blob"], ["160000", "commit"]] as const) {
      world.gate.github.trees.set(TREE, [{ path: "src", mode: "040000", type: "tree", sha: SRC }]);
      world.gate.github.trees.set(SRC, [{ path: "attendance.ts", mode, type, sha: "e".repeat(40) }]);
      expect(await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 403)).toMatchObject({ code: "rule_denied" });
    }
    expect(treeEntries()).toEqual([]);
    expect(commitBodies()).toEqual([]);
  });

  it("サブモジュールの中のファイルを書き換えるコミットは 403 で断る", async () => {
    const { task } = await openReview(world);
    world.gate.github.trees.set(TREE, [{ path: "src", mode: "160000", type: "commit", sha: SRC }]);
    expect(await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 403)).toMatchObject({ code: "rule_denied" });
  });

  it("読む時は contents の読みだけに絞った鍵を付ける", async () => {
    const { task } = await openReview(world);
    world.gate.github.trees.set(TREE, [{ path: "src", mode: "040000", type: "tree", sha: SRC }]);
    world.gate.github.trees.set(SRC, []);
    await api(world, "POST", `/api/v1/reviews/${task}/commits`, CHANGE, 201);
    const reads = world.gate.github.requests.filter((r) => r.route.startsWith(`GET /repos/${REPO}/git/`));
    expect(reads.map((r) => r.route)).toEqual([`GET /repos/${REPO}/git/commits/${HEAD}`, `GET /repos/${REPO}/git/trees/${TREE}`, `GET /repos/${REPO}/git/trees/${SRC}`]);
    for (const r of reads) {
      const t = world.gate.github.tokens.get(r.token ?? "");
      expect(t?.repos).toEqual([REPO]);
      expect(t?.permissions).toEqual({ contents: "read" });
    }
  });
});
