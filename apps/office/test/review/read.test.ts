// レビューを読む道。ワークスペースを起こさず、ゲートウェイが GitHub の compare とファイルの API から取り、前に見た所からの差を出す (タスクとレビューの 3.6、要件 review の指摘とワークスペースを起こす時)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hook } from "../helpers/github.ts";
import { BASE, HEAD, openReview } from "../helpers/review.ts";
import { api, REPO, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

/** 社員が指摘を直して push した後の先 */
const NEXT = "e".repeat(40);

const PATCH = "@@ -10,3 +10,4 @@ export function total\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n\\ No newline at end of file";
const FIXED = "@@ -11,1 +11,1 @@\n-const b = 3;\n+const b = 0;";

/**
 * compare が返すファイルを「元...先」ごとに置く
 * @param w テストの物
 * @param range 元...先
 * @param files GitHub の形のファイル
 */
function compareOf(w: WorkWorld, range: string, files: { filename: string; status: string; patch?: string; previous_filename?: string }[]): void {
  w.gate.github.compares.set(range, files);
}

/**
 * GitHub への compare の要求の「元...先」を並べる
 * @param w テストの物
 * @returns 元...先
 */
function compared(w: WorkWorld): string[] {
  const head = `GET /repos/${REPO}/compare/`;
  return w.gate.github.requests.filter((r) => r.route.startsWith(head)).map((r) => r.route.slice(head.length));
}

/**
 * 読んだ所の印を置く。204 は本文が無いので、ステータスだけを返す
 * @param w テストの物
 * @param task レビューの nodeId
 * @param sha 読んだ先
 * @returns ステータス
 */
async function markSeen(w: WorkWorld, task: string, sha: string): Promise<number> {
  const res = await w.gate.request(`/api/v1/reviews/${task}/seen`, { method: "PUT", headers: { ...w.headers, "Content-Type": "application/json" }, body: JSON.stringify({ sha }) });
  return res.status;
}

/**
 * ワークスペースを呼んだ数を数える
 * @param w テストの物
 * @returns 呼んだ数を返す関数
 */
function countWorkspace(w: WorkWorld): () => number {
  let n = 0;
  const real = w.gate.env.WORKSPACE;
  const get = real.get.bind(real);
  // テストのゲートウェイはテストごとに作り直すので、元に戻さない
  real.get = (id) => {
    n += 1;
    return get(id);
  };
  return () => n;
}

const Head = z.object({
  nodeId: z.string(),
  repo: z.string(),
  prNumber: z.number(),
  branch: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  lastSeenSha: z.string().nullable(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  reviewerSummary: z.string(),
  reviewerVerdict: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), status: z.string(), seen: z.boolean() })),
}).strict();

describe("指摘", () => {
  it("直った後の差", async () => {
    const { task, c } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, [{ filename: "src/a.ts", status: "modified", patch: PATCH }, { filename: "src/b.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+export {};" }]);
    // オーナーが今の先まで読んだ印を置く
    expect(await markSeen(world, task, HEAD)).toBe(204);
    // 社員が指摘を直して push すると、synchronize の通知が先を進める
    await hook(world, { event: "pull_request", payload: { action: "synchronize", pull_request: { number: 1, head: { sha: NEXT } }, repository: { full_name: REPO }, installation: { id: c.installationId } }, secret: c.webhookSecret });
    compareOf(world, `${BASE}...${NEXT}`, [{ filename: "src/a.ts", status: "modified", patch: PATCH }, { filename: "src/b.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+export {};" }]);
    compareOf(world, `${HEAD}...${NEXT}`, [{ filename: "src/a.ts", status: "modified", patch: FIXED }]);
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    expect(head).toMatchObject({ headSha: NEXT, lastSeenSha: HEAD });
    expect(head.files).toEqual([
      { path: "src/a.ts", status: "modified", seen: false },
      { path: "src/b.ts", status: "added", seen: true },
    ]);
    // 前に見た所からの差だけを開ける
    const diff = await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&since=${HEAD}`);
    expect(diff).toEqual({ path: "src/a.ts", language: "typescript", hunks: [{ oldStart: 11, newStart: 11, lines: ["-const b = 3;", "+const b = 0;"] }] });
    expect(compared(world).at(-1)).toBe(`${HEAD}...${NEXT}`);
  });
});

describe("レビューを読む", () => {
  it("概要は、要点とチェックと変えたファイルの木を返す", async () => {
    const { task } = await openReview(world);
    await world.d1.DB.prepare("UPDATE reviews SET reviewer_summary = ?, checks = ? WHERE node_id = ?").bind("空の日の扱いを直した", JSON.stringify([{ name: "verify", ok: true }]), task).run();
    compareOf(world, `${BASE}...${HEAD}`, [
      { filename: "src/a.ts", status: "modified" },
      { filename: "src/new.ts", status: "renamed", previous_filename: "src/old.ts" },
      { filename: "src/gone.ts", status: "removed" },
      { filename: "src/copy.ts", status: "copied" },
    ]);
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    const branch = (await rows(world.d1.DB, "SELECT branch FROM reviews WHERE node_id = ?", task))[0]?.["branch"];
    expect(head).toEqual({
      nodeId: task,
      repo: REPO,
      prNumber: 1,
      branch,
      baseSha: BASE,
      headSha: HEAD,
      lastSeenSha: null,
      checks: [{ name: "verify", ok: true }],
      reviewerSummary: "空の日の扱いを直した",
      reviewerVerdict: null,
      files: [
        { path: "src/a.ts", status: "modified", seen: false },
        { path: "src/new.ts", status: "renamed", seen: false },
        { path: "src/gone.ts", status: "removed", seen: false },
        { path: "src/copy.ts", status: "added", seen: false },
      ],
    });
  });

  it("今の先まで読んでいれば、どのファイルも読んだ事にし、差を GitHub に聞かない", async () => {
    const { task } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, [{ filename: "src/a.ts", status: "modified" }]);
    expect(await markSeen(world, task, HEAD)).toBe(204);
    const before = compared(world).length;
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    expect(head.files).toEqual([{ path: "src/a.ts", status: "modified", seen: true }]);
    expect(compared(world).slice(before)).toEqual([`${BASE}...${HEAD}`]);
  });

  it("1 ファイルの差分を、行の頭の印ごと返す。印の無い知らせの行は落とす", async () => {
    const { task } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, [{ filename: "README.md", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }, { filename: "src/a.ts", status: "modified", patch: PATCH }]);
    expect(await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts`)).toEqual({
      path: "src/a.ts",
      language: "typescript",
      hunks: [{ oldStart: 10, newStart: 10, lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;"] }],
    });
    expect(await api(world, "GET", `/api/v1/reviews/${task}/diff?path=README.md`)).toMatchObject({ language: "markdown", hunks: [{ oldStart: 1, newStart: 1, lines: ["-a", "+b"] }] });
  });

  it("変えていないファイルの差分は 404", async () => {
    const { task } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    expect(await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fother.ts`, undefined, 404)).toMatchObject({ code: "not_found" });
  });

  it("道と sha の形が違えば 422、知らない問いは 400 で、GitHub に聞かない", async () => {
    const { task } = await openReview(world);
    const before = world.gate.github.requests.length;
    for (const query of ["path=..%2Fx.ts", "path=src%2F%2Fx.ts", `path=src%2Fa.ts&since=${"g".repeat(40)}`, "path=src%2Fa.ts&since=HEAD~1"]) {
      expect(await api(world, "GET", `/api/v1/reviews/${task}/diff?${query}`, undefined, 422)).toMatchObject({ code: "validation_failed" });
    }
    expect(await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=main`, undefined, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts&raw=1`, undefined, 400)).toMatchObject({ code: "malformed_request" });
    expect(world.gate.github.requests.length).toBe(before);
  });

  it("前と後のファイルの中身を、読んだ sha と一緒に返す", async () => {
    const { task } = await openReview(world);
    world.gate.github.contents.set(`${BASE}:src/a.ts`, "const b = 2;\n");
    world.gate.github.contents.set(`${HEAD}:src/a.ts`, "const b = 3; // 日本語\n");
    expect(await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=base`)).toEqual({ path: "src/a.ts", ref: BASE, content: "const b = 2;\n" });
    expect(await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=head`)).toEqual({ path: "src/a.ts", ref: HEAD, content: "const b = 3; // 日本語\n" });
    // 中身は contents の読みだけに絞った鍵で読む
    const read = world.gate.github.requests.filter((r) => r.route === `GET /repos/${REPO}/contents/src/a.ts`);
    expect(read).toHaveLength(2);
    expect(read.map((r) => world.gate.github.tokens.get(r.token ?? "")?.permissions)).toEqual([{ contents: "read" }, { contents: "read" }]);
  });

  it("無いファイルの中身は 404", async () => {
    const { task } = await openReview(world);
    expect(await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fnone.ts&ref=head`, undefined, 404)).toMatchObject({ code: "not_found" });
  });

  it("300 ファイルを超える変更は、compare の続きのページまで読む", async () => {
    const { task } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, Array.from({ length: 301 }, (_, i) => ({ filename: `src/f${String(i)}.ts`, status: "added" })));
    const head = Head.parse(await api(world, "GET", `/api/v1/reviews/${task}`));
    expect(head.files).toHaveLength(301);
    expect(head.files.at(-1)).toEqual({ path: "src/f300.ts", status: "added", seen: false });
    expect(compared(world).filter((r) => r.startsWith(`${BASE}...${HEAD}`))).toEqual([`${BASE}...${HEAD}`, `${BASE}...${HEAD}`]);
  });

  it("3,000 ファイルを超える変更は、読み切れないので 502", async () => {
    const { task } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, Array.from({ length: 3001 }, (_, i) => ({ filename: `src/f${String(i)}.ts`, status: "added" })));
    expect(await api(world, "GET", `/api/v1/reviews/${task}`, undefined, 502)).toMatchObject({ code: "upstream_failed" });
    expect(compared(world).filter((r) => r.startsWith(`${BASE}...${HEAD}`))).toHaveLength(10);
  });

  it("GitHub が失敗したら 502", async () => {
    const { task } = await openReview(world);
    world.gate.github.failNext(`GET /repos/${REPO}/compare/${BASE}...${HEAD}`, 500);
    expect(await api(world, "GET", `/api/v1/reviews/${task}`, undefined, 502)).toMatchObject({ code: "upstream_failed" });
  });

  it("無いレビューは 404", async () => {
    await openReview(world);
    const id = crypto.randomUUID();
    expect(await api(world, "GET", `/api/v1/reviews/${id}`, undefined, 404)).toMatchObject({ code: "not_found" });
    expect(await api(world, "GET", `/api/v1/reviews/${id}/diff?path=a.ts`, undefined, 404)).toMatchObject({ code: "not_found" });
    expect(await api(world, "PUT", `/api/v1/reviews/${id}/seen`, { sha: HEAD }, 404)).toMatchObject({ code: "not_found" });
  });

  it("読む道はワークスペースを起こさない", async () => {
    const { task } = await openReview(world);
    compareOf(world, `${BASE}...${HEAD}`, [{ filename: "src/a.ts", status: "modified", patch: PATCH }]);
    world.gate.github.contents.set(`${HEAD}:src/a.ts`, "x");
    const calls = countWorkspace(world);
    await api(world, "GET", `/api/v1/reviews/${task}`);
    await api(world, "GET", `/api/v1/reviews/${task}/diff?path=src%2Fa.ts`);
    await api(world, "GET", `/api/v1/reviews/${task}/file?path=src%2Fa.ts&ref=head`);
    expect(await markSeen(world, task, HEAD)).toBe(204);
    expect(calls()).toBe(0);
  });
});

describe("読んだ所の印", () => {
  it("今の先を読んだ印を置く", async () => {
    const { task } = await openReview(world);
    expect(await markSeen(world, task, HEAD)).toBe(204);
    expect(await rows(world.d1.DB, "SELECT last_seen_sha FROM reviews WHERE node_id = ?", task)).toEqual([{ last_seen_sha: HEAD }]);
  });

  it("読んだ後に先が進んでいたら 409 で、印を動かさない", async () => {
    const { task } = await openReview(world);
    expect(await api(world, "PUT", `/api/v1/reviews/${task}/seen`, { sha: NEXT }, 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT last_seen_sha FROM reviews WHERE node_id = ?", task)).toEqual([{ last_seen_sha: null }]);
  });

  it("sha の形が違えば 422", async () => {
    const { task } = await openReview(world);
    for (const sha of ["main", HEAD.toUpperCase(), `${HEAD}0`]) {
      expect(await api(world, "PUT", `/api/v1/reviews/${task}/seen`, { sha }, 422)).toMatchObject({ code: "validation_failed" });
    }
    expect(await api(world, "PUT", `/api/v1/reviews/${task}/seen`, { sha: HEAD, extra: 1 }, 422)).toMatchObject({ code: "validation_failed" });
  });
});
