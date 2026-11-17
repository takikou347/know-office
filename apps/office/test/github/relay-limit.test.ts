// ワークスペースからの api.github.com の中継は、GitHub の上限の待つ時刻を社員に返す (タスクとレビューの 3.3)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { useWork } from "../helpers/work.ts";
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
