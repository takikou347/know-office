// オーナーがレビューで書き換えた 1 ファイルを、ゲートウェイが Git の API で同じブランチにコミットする (タスクとレビューの 3.6、要件 review のその場で直す)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, REPO, rows, useWork } from "../helpers/work.ts";
import { HEAD, openReview } from "../helpers/review.ts";

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
    expect(gitRoutes()).toEqual([`GET /repos/${REPO}/git/commits/${HEAD}`, `POST /repos/${REPO}/git/blobs`, `POST /repos/${REPO}/git/trees`, `POST /repos/${REPO}/git/commits`, `PATCH /repos/${REPO}/git/refs/heads/${branch}`]);
    expect(world.gate.github.heads.get(`${REPO}:${branch}`)).toBe(sha);
    // 変更の表示は新しい先から読み直す
    expect(await rows(world.d1.DB, "SELECT head_sha, checks FROM reviews WHERE node_id = ?", task)).toEqual([{ head_sha: sha, checks: "[]" }]);
    expect(world.gate.audits.find((a) => a.action === "review.commit")).toMatchObject({ actor: "owner", target: task, detail: { repo: REPO, sha, path: CHANGE.path } });
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
});
