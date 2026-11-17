// ワークスペースからの api.github.com の中継は、GitHub の上限の待つ時刻を社員に返し、上限に届いた事を通知に出す (タスクとレビューの 3.3、サービスと拡張の 3.5)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { rows, useWork } from "../helpers/work.ts";
import { connect, fromWorkspace, startTask } from "../helpers/github.ts";

/** 写す上限の見出し */
const LIMIT = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "x-github-request-id"];

const world = useWork();

const UI = "example/knowidea-ui";

describe("GitHub の上限の中継", () => {
  it("GitHub の上限の返事は、待つ時刻の見出しを付けたままワークスペースに返す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.failNext(`GET /repos/${UI}/pulls`, 403, { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000", "x-github-request-id": "ABC" });
    const read = await fromWorkspace(world, { staffId: "builder" }, new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${work.token}` } }));
    const seen = LIMIT.map((name) => read.headers.get(name));
    expect({ status: read.status, seen }).toEqual({ status: 403, seen: ["60", "0", "1893456000", null] });
  });

  it("git の上限の返事も、待つ時刻の見出しを付けたままワークスペースに返す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.failNext(`GET /${UI}.git/info/refs`, 429, { "retry-after": "30", "x-github-request-id": "ABC" });
    const read = await fromWorkspace(world, { staffId: "builder" }, new Request(`https://github.com/${UI}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`x-access-token:${work.token}`)}` } }));
    expect({ status: read.status, seen: LIMIT.map((name) => read.headers.get(name)) }).toEqual({ status: 429, seen: ["30", null, null, null] });
  });

  it("ゲートウェイが GitHub を呼んで上限に当たったら、待つ秒を付けた 429 を返す", async () => {
    await connect(world);
    world.gate.github.failNext("GET /installation/repositories", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456060", date: "Tue, 01 Jan 2030 00:00:00 GMT" });
    const res = await world.gate.request("/api/v1/github/repos", { headers: world.headers });
    const body = z.object({ code: z.string() }).loose().parse(await res.json());
    expect({ status: res.status, retryAfter: res.headers.get("retry-after"), code: body.code }).toEqual({ status: 429, retryAfter: "60", code: "rate_limited" });
  });
});

/**
 * GitHub のレート制限のエラーログの数を読む。エラーログはテストごとに戻らないので、テストの頭の数との差で見る
 * @returns エラーログの数
 */
async function rateErrors(): Promise<number> {
  return (await rows(world.d1.REC_2026, "SELECT id FROM error_events WHERE code = 'github_rate_limited'")).length;
}

/**
 * GitHub のレート制限の通知と、テストの頭から増えたエラーログの数を読む
 * @param before テストの頭のエラーログの数
 * @returns 通知の段と既読、増えたエラーログの数
 */
async function rateNotices(before: number): Promise<{ notices: Record<string, unknown>[]; errors: number }> {
  const notices = await rows(world.d1.DB, "SELECT level, read_at IS NOT NULL AS read FROM notices WHERE kind = 'github_rate_limited' ORDER BY at");
  return { notices, errors: (await rateErrors()) - before };
}

describe("落ちても続きから", () => {
  it("GitHub のレート制限に届く", async () => {
    const before = await rateErrors();
    await connect(world);
    const work = await startTask(world, UI);
    // 中継の 403 (残り 0)、git の 429、ゲートウェイが呼んだ 403 (retry-after) のどれも数え、通知は読むまで 1 件
    world.gate.github.failNext(`GET /repos/${UI}/pulls`, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" });
    const api = await fromWorkspace(world, work, new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${work.token}` } }));
    // 通知を出しても、中継の返事は変えない
    expect({ status: api.status, remaining: api.headers.get("x-ratelimit-remaining"), reset: api.headers.get("x-ratelimit-reset") }).toEqual({ status: 403, remaining: "0", reset: "1893456000" });
    world.gate.github.failNext(`GET /${UI}.git/info/refs`, 429, { "retry-after": "30" });
    const git = await fromWorkspace(world, work, new Request(`https://github.com/${UI}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`x-access-token:${work.token}`)}` } }));
    expect({ status: git.status, retryAfter: git.headers.get("retry-after") }).toEqual({ status: 429, retryAfter: "30" });
    world.gate.github.failNext("GET /installation/repositories", 403, { "retry-after": "60" });
    await world.gate.request("/api/v1/github/repos", { headers: world.headers });
    expect(await rateNotices(before)).toEqual({ notices: [{ level: "warn", read: 0 }], errors: 3 });
    // 読んだ後にまた届けば、また通知を出す
    await world.d1.DB.prepare("UPDATE notices SET read_at = ? WHERE kind = 'github_rate_limited'").bind(world.clock.now()).run();
    world.gate.github.failNext(`GET /repos/${UI}/pulls`, 429, {});
    await fromWorkspace(world, work, new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${work.token}` } }));
    expect(await rateNotices(before)).toEqual({ notices: [{ level: "warn", read: 1 }, { level: "warn", read: 0 }], errors: 4 });
  });

  it("残りが 0 でなく retry-after も無い 403 は、レート制限に数えない", async () => {
    const before = await rateErrors();
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.failNext(`GET /repos/${UI}/pulls`, 403, { "x-ratelimit-remaining": "4999" });
    const res = await fromWorkspace(world, work, new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${work.token}` } }));
    expect(res.status).toBe(403);
    expect(await rateNotices(before)).toEqual({ notices: [], errors: 0 });
  });
});
