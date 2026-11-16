// ワークスペースからの api.github.com の中継は、GitHub の上限の待つ時刻を社員に返す (タスクとレビューの 3.3)
import { describe, expect, it } from "vitest";
import { useWork } from "../helpers/work.ts";
import { connect, fromWorkspace, startTask } from "../helpers/github.ts";

const world = useWork();

const UI = "example/knowidea-ui";

describe("GitHub の上限の中継", () => {
  it("GitHub の上限の返事は、待つ時刻の見出しを付けたままワークスペースに返す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.failNext(`GET /repos/${UI}/pulls`, 403, { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000", "x-github-request-id": "ABC" });
    const read = await fromWorkspace(world, { staffId: "builder" }, new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${work.token}` } }));
    const seen = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "x-github-request-id"].map((name) => read.headers.get(name));
    expect({ status: read.status, seen }).toEqual({ status: 403, seen: ["60", "0", "1893456000", null] });
  });
});
