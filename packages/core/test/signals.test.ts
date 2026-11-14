// シグナルの数え方を、社員の動きを並べたモックの出来事で確かめる (自動停止の 3.1、3.2、4 章)
import { describe, expect, it } from "vitest";
import {
  countOffice,
  countStaff,
  DEFAULT_THRESHOLDS,
  decide,
  DEFAULT_RULES,
  emptyOfficeCounts,
  emptyStaffCounts,
  GuardEvent,
  isStaffEvent,
  type Judgment,
  resetTask,
  setBaseline,
  taskOverrun,
  toOperation,
} from "../src/index.ts";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const NODE = "0190f5c2-0000-7000-8000-000000000001";
const NODE2 = "0190f5c2-0000-7000-8000-000000000002";
const th = DEFAULT_THRESHOLDS;

/**
 * 社員の出来事を順に数え、答えを並べる
 * @param events 出来事と時刻
 * @param counts 数の入れ物
 * @returns 答え
 */
function staffRun(events: [number, unknown][], counts = emptyStaffCounts("builder")): Judgment[] {
  return events.map(([at, event]) => {
    const parsed = GuardEvent.parse(event);
    if (!isStaffEvent(parsed)) throw new Error("社員の出来事でない");
    return countStaff(counts, parsed, at, th);
  });
}

/**
 * 全体の出来事を順に数え、答えを並べる
 * @param events 出来事と時刻
 * @param counts 数の入れ物
 * @returns 答え
 */
function officeRun(events: [number, unknown][], counts = emptyOfficeCounts()): Judgment[] {
  return events.map(([at, event]) => {
    const parsed = GuardEvent.parse(event);
    if (isStaffEvent(parsed)) throw new Error("全体の出来事でない");
    return countOffice(counts, parsed, at, th);
  });
}

const denied = (nodeId = NODE, target = "/etc/passwd") => ({ type: "rule_denied", staffId: "builder", nodeId, operation: "file.read", target });
const failed = (exitCode = 1) => ({ type: "command_result", staffId: "builder", nodeId: NODE, command: "pnpm test", exitCode, failedCheck: exitCode === 0 ? null : "unit" });
const usage = (tokens: number) => ({ type: "usage", staffId: "builder", tokens });
const web = (baselineRate: number, responses: number, failures: number) => ({ type: "deploy_result", serviceId: "knowidea-ui", kind: "web", deployedAt: T0, baselineRate, responses, failures });

describe("止めるのはシステム", () => {
  it("タスク 1 つを止める", () => {
    const [j] = staffRun([[T0, denied()]]);
    expect(j).toEqual({ action: "stop", scope: "task", target: NODE, signal: "rule_denied", measured: 1, threshold: 1 });
  });

  it("社員 1 人を止める", () => {
    const answers = staffRun([
      [T0, denied(NODE)],
      [T0 + 59 * MINUTE, denied(NODE2, "/root")],
    ]);
    expect(answers[1]).toEqual({ action: "stop", scope: "staff", target: "builder", signal: "staff_rule_denied", measured: 2, threshold: 2 });
    // 60 分を過ぎた 1 回は社員を止めない
    const late = staffRun([
      [T0, denied(NODE)],
      [T0 + 61 * MINUTE, denied(NODE2, "/root")],
    ]);
    expect(late[1]).toMatchObject({ scope: "task", target: NODE2 });
  });

  it("サービス 1 つを止める", () => {
    const [j] = officeRun([[T0 + 5 * MINUTE, web(0.02, 30, 2)]]);
    expect(j).toEqual({ action: "stop", scope: "service", target: "knowidea-ui", signal: "deploy_failure", measured: 667, threshold: 500 });
  });

  it("2 倍を超えない", () => {
    const [j] = officeRun([[T0 + 5 * MINUTE, web(0.04, 100, 6)]]);
    expect(j?.action).not.toBe("stop");
  });

  it("全体を止める", () => {
    for (const event of [{ type: "chain_broken", year: 2026 }, { type: "ticket_misuse", staffId: "builder", jti: "j1", workspaceId: "other" }, { type: "threshold_mismatch" }]) {
      expect(officeRun([[T0, event]])[0]).toMatchObject({ action: "stop", scope: "office", target: "office", signal: "certain_fraud" });
    }
  });
});

describe("シグナルを数える場所", () => {
  it("社員が数を読もうとする", () => {
    const op = toOperation("Bash", { command: "curl http://gate/api/v1/guard/state" });
    expect(op.kind).toBe("guard.access");
    expect(decide(op, DEFAULT_RULES).allow).toBe(false);
    const [j] = staffRun([[T0, { type: "rule_denied", staffId: "builder", nodeId: NODE, operation: op.kind, target: op.target }]]);
    expect(j).toMatchObject({ action: "stop", scope: "task", signal: "rule_denied" });
  });
});

describe("タスクを止めるシグナル", () => {
  it("同じ操作をまとめる", () => {
    const counts = emptyStaffCounts("builder");
    const answers = staffRun(
      [
        [T0, denied()],
        [T0 + 3 * MINUTE, denied()],
        [T0 + 9 * MINUTE, denied()],
      ],
      counts,
    );
    expect(answers.map((j) => j.action)).toEqual(["stop", "none", "none"]);
    // 社員の 60 分の数にも 1 回だけ入る
    expect(counts.deniedAt).toEqual([T0]);
  });

  it("成功で 0 に戻る", () => {
    const counts = emptyStaffCounts("builder");
    const answers = staffRun(
      [
        [T0, failed()],
        [T0 + MINUTE, failed()],
        [T0 + 2 * MINUTE, failed(0)],
        [T0 + 3 * MINUTE, failed()],
        [T0 + 4 * MINUTE, failed()],
      ],
      counts,
    );
    expect(answers.map((j) => j.action)).toEqual(["none", "none", "none", "none", "none"]);
    expect(counts.tasks[NODE]?.failure?.count).toBe(2);
    expect(staffRun([[T0 + 5 * MINUTE, failed()]], counts)[0]).toMatchObject({ action: "stop", scope: "task", signal: "repeated_failure", measured: 3, threshold: 3 });
  });

  it("チェックを通らないマージ", () => {
    const [passed, unchecked] = staffRun([
      [T0, { type: "merge_requested", staffId: "builder", nodeId: NODE, checksPassed: true }],
      [T0, { type: "merge_requested", staffId: "builder", nodeId: NODE, checksPassed: false }],
    ]);
    expect(passed?.action).toBe("none");
    expect(unchecked).toMatchObject({ action: "stop", scope: "task", target: NODE, signal: "unchecked_merge" });
  });
});

describe("社員を止めるシグナル", () => {
  it("普段の値がたまる前", () => {
    const counts = emptyStaffCounts("builder");
    setBaseline(counts, { tokens: 1000, toolCalls: 10, days: 6 }, "2026-11-16");
    const answers = staffRun(
      [
        [T0, usage(6000)],
        [T0 + 5 * MINUTE, usage(6000)],
      ],
      counts,
    );
    expect(answers.map((j) => j.action)).not.toContain("stop");
    expect(answers[1]).toMatchObject({ action: "near", scope: "staff", signal: "token_rate" });
    // 7 日分あれば同じ動きで止まる
    const ready = emptyStaffCounts("builder");
    setBaseline(ready, { tokens: 1000, toolCalls: 10, days: 7 }, "2026-11-16");
    const stopped = staffRun(
      [
        [T0, usage(6000)],
        [T0 + 5 * MINUTE, usage(6000)],
      ],
      ready,
    );
    expect(stopped[1]).toEqual({ action: "stop", scope: "staff", target: "builder", signal: "token_rate", measured: 6000, threshold: 5000 });
  });

  it("操作の速さも 5 分が 2 つ続くと止める", () => {
    const counts = emptyStaffCounts("builder");
    setBaseline(counts, { tokens: 1000, toolCalls: 2, days: 7 }, "2026-11-16");
    const calls: [number, unknown][] = [];
    for (let n = 0; n < 11; n += 1) calls.push([T0 + n * 1000, { type: "tool_call", staffId: "builder" }]);
    for (let n = 0; n < 11; n += 1) calls.push([T0 + 5 * MINUTE + n * 1000, { type: "tool_call", staffId: "builder" }]);
    expect(staffRun(calls, counts).at(-1)).toMatchObject({ action: "stop", signal: "tool_rate", measured: 11, threshold: 10 });
  });

  it("外部の文章を読んだ後", () => {
    const [clean] = staffRun([[T0, { type: "sensitive_access", staffId: "builder", nodeId: NODE, item: "address" }]]);
    expect(clean?.action).toBe("none");
    const answers = staffRun([
      [T0, { type: "external_read", staffId: "builder", nodeId: NODE, source: "https://example.com/" }],
      [T0 + MINUTE, { type: "sensitive_access", staffId: "builder", nodeId: NODE, item: "address" }],
    ]);
    expect(answers[1]).toEqual({ action: "stop", scope: "staff", target: "builder", signal: "exfiltration", measured: 1, threshold: 1 });
  });
});

describe("サービスを止めるシグナル", () => {
  it("返事が少ない公開", () => {
    expect(officeRun([[T0 + MINUTE, web(0.02, 19, 5)]])[0]?.action).toBe("none");
    // 足して 20 件に届いたら判断する
    const counts = emptyOfficeCounts();
    expect(officeRun([[T0 + MINUTE, web(0.02, 19, 5)], [T0 + 2 * MINUTE, web(0.02, 1, 0)]], counts)[1]).toMatchObject({ action: "stop", measured: 2500 });
    // 10 分を過ぎた返事は数えない
    expect(officeRun([[T0 + 11 * MINUTE, web(0.02, 30, 20)]])[0]?.action).toBe("none");
  });

  it("ライブラリの公開", () => {
    const [ok, broken] = officeRun([
      [T0, { type: "deploy_result", serviceId: "knowidea-ui", kind: "library", version: "0.13.0", buildPassed: true }],
      [T0, { type: "deploy_result", serviceId: "knowidea-ui", kind: "library", version: "0.13.0", buildPassed: false }],
    ]);
    expect(ok?.action).toBe("none");
    expect(broken).toMatchObject({ action: "stop", scope: "service", target: "knowidea-ui", signal: "library_build" });
  });
});

describe("全体を止めるシグナル", () => {
  it("作業トークンの横取り", () => {
    expect(officeRun([[T0, { type: "ticket_misuse", staffId: "builder", jti: "j1", workspaceId: "ws-other" }]])[0]).toMatchObject({ action: "stop", scope: "office" });
  });

  it("怪しい動きが重なる", () => {
    const events: [number, unknown][] = [[T0, { type: "login", country: "US", newCountry: true }]];
    for (let n = 0; n < 25; n += 1) events.push([T0 + 10 * MINUTE + n * 10_000, { type: "owner_info_read", item: "address" }]);
    const answers = officeRun(events);
    expect(answers.findIndex((j) => j.action === "stop")).toBe(21);
    expect(answers[21]).toEqual({ action: "stop", scope: "office", target: "office", signal: "stacked_suspicion", measured: 21, threshold: 20 });
  });
});

describe("誤って止めない", () => {
  it("新しい国からのログインだけ", () => {
    const answers = officeRun([
      [T0, { type: "login", country: "US", newCountry: true }],
      [T0 + MINUTE, { type: "owner_info_read", item: "address" }],
    ]);
    expect(answers.map((j) => j.action)).toEqual(["none", "none"]);
    // 新しい国のログインが無ければ、読み出しが多くても止めない
    const reads: [number, unknown][] = [];
    for (let n = 0; n < 30; n += 1) reads.push([T0 + n * 1000, { type: "owner_info_read", item: "address" }]);
    expect(officeRun(reads).map((j) => j.action)).not.toContain("stop");
  });
});

describe("再開", () => {
  it("レビュー担当が再開する", () => {
    const counts = emptyStaffCounts("builder");
    staffRun(
      [
        [T0, denied()],
        [T0 + MINUTE, failed()],
        [T0 + 2 * MINUTE, failed()],
      ],
      counts,
    );
    resetTask(counts, NODE);
    expect(counts.tasks[NODE]).toBeUndefined();
    expect(counts.deniedAt).toEqual([T0]);
    // 再開の後、同じ相手への同じ操作は新しい 1 回として数え、60 分の 2 回目で社員が止まる
    expect(staffRun([[T0 + 3 * MINUTE, denied()]], counts)[0]).toMatchObject({ action: "stop", scope: "staff" });
  });
});

describe("止める仕組みを守る", () => {
  it("社員が基準を変えようとする", () => {
    const op = toOperation("Bash", { command: "curl -X PUT http://gate/api/v1/guard/thresholds -d '{}'" });
    expect(decide(op, DEFAULT_RULES)).toMatchObject({ allow: false });
    const [j] = staffRun([[T0, { type: "rule_denied", staffId: "builder", nodeId: NODE, operation: op.kind, target: op.target }]]);
    expect(j).toMatchObject({ action: "stop", signal: "rule_denied" });
  });
});

describe("止めた記録", () => {
  it("近かった", () => {
    const counts = emptyStaffCounts("builder");
    setBaseline(counts, { tokens: 1000, toolCalls: 10, days: 7 }, "2026-11-16");
    const answers = staffRun(
      [
        [T0, { type: "usage", staffId: "builder", tokens: 3999 }],
        [T0 + 1000, { type: "usage", staffId: "builder", tokens: 1 }],
        [T0 + 2000, { type: "usage", staffId: "builder", tokens: 100 }],
      ],
      counts,
    );
    expect(answers.map((j) => j.action)).toEqual(["none", "near", "none"]);
    expect(answers[1]).toEqual({ action: "near", scope: "staff", target: "builder", signal: "token_rate", measured: 4000, threshold: 5000 });
    // 1 時間を過ぎたら、また近かったを残す
    expect(staffRun([[T0 + 61 * MINUTE, { type: "usage", staffId: "builder", tokens: 4000 }]], counts)[0]?.action).toBe("near");
  });
});

describe("タスクを止めるシグナル", () => {
  it("1 つのタスクの最長時間", () => {
    expect(taskOverrun(NODE, th.taskMaxMs - 1, th).action).toBe("none");
    expect(taskOverrun(NODE, th.taskMaxMs, th)).toEqual({ action: "stop", scope: "task", target: NODE, signal: "task_overrun", measured: th.taskMaxMs, threshold: th.taskMaxMs });
  });
});
