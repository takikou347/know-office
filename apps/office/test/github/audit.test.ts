// App を通した操作の記録。社員がプルリクエストを出すと、どの社員がどのタスクで出したかが監査ログに残る (タスクとレビューの 3.3)
import { describe, expect, it } from "vitest";
import { vaultForge } from "../../src/gate/github/vault-forge.ts";
import { createNode } from "../../src/gate/work/nodes.ts";
import { runTool } from "../../src/gate/work/tools.ts";
import { clockIn, purposeAndGoal, staffOf, useWork } from "../helpers/work.ts";
import { connect } from "../helpers/github.ts";

const world = useWork();

const UI = "example/knowidea-ui";
const SHA = { base: "a".repeat(40), head: "b".repeat(40) };

describe("App を通した操作を記録する", () => {
  it("操作の記録", async () => {
    await connect(world);
    const { goal } = await purposeAndGoal(world);
    await clockIn(world, "builder", "reviewer");
    const actor = { by: "owner", now: world.clock.now() } as const;
    const project = (await createNode(world.gate.env, { kind: "project", parentId: goal, scope: "office", title: "勤怠" }, actor)).id;
    const task = (await createNode(world.gate.env, { kind: "task", parentId: project, scope: "office", title: "勤怠の表をつなぐ", taskKind: "build", assignee: "builder", repo: UI }, actor)).id;
    await staffOf(world, "builder").pull(world.clock.now());
    world.gate.github.set(`POST /repos/${UI}/pulls`, { number: 3, base: { sha: SHA.base }, head: { sha: SHA.head } });
    // ゲートウェイと同じく、vault の App の鍵から鍵を作る口で呼ぶ
    const forge = vaultForge(world.gate.env, { fetcher: world.gate.fetch, clock: world.clock, cache: world.gate.githubCache });
    await runTool(world.gate.env, forge, { staffId: "builder", tool: "pr_open", input: { name: "attendance-table", title: "勤怠の表をつなぐ", body: "" }, now: world.clock.now(), guard: world.gate.deps });

    expect(world.gate.audits.filter((a) => a.action === "pull_request.open")).toEqual([expect.objectContaining({ actor: "builder", target: task, detail: { repo: UI, prNumber: 3 } })]);
    // プルリクエストは knowidea-ui だけに、プルリクエストを書ける鍵で出した
    const opened = world.gate.github.requests.find((r) => r.route === `POST /repos/${UI}/pulls`);
    expect(world.gate.github.tokens.get(opened?.token ?? "")).toMatchObject({ repos: [UI], permissions: { pull_requests: "write" } });
  });
});
