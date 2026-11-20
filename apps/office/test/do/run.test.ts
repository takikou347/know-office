// 社員がタスクを取った時に自分で最初の runs を呼び、失敗を数え、鍵の失敗の間は呼ばない事を、本物の workerd で確かめる (社員が考えるの 3.3、タスクとレビューの 3.1)
import { ORG_RULES, ROLE_TOOLS, toBase64 } from "@know-office/core";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jst, TASK } from "../helpers/staff.ts";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

const BUILDER_PROMPT = "無いデータを作らず、分からない所は「未確認」と書く。タスクを 1 つずつ取り、ワークスペースで直して試し、プルリクエストを出す。困った時は社長に上げる。";
const RunCall = z.object({ nodeId: z.string(), ticket: z.string(), systemPrompt: z.string(), prompt: z.string(), tools: z.array(z.string()) }).loose();

/**
 * 待たずに頼んだ後の動きが済むまで待つ
 * @param done 済んだか
 */
async function until(done: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 100 && !(await done()); n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * 開発担当のワークスペースが受けた runs を並べる
 * @param worker テストの入口
 * @returns runs の入力
 */
async function runs(worker: TestWorker): Promise<z.infer<typeof RunCall>[]> {
  return (await worker.workspace("builder")).filter((c) => c.method === "run").map((c) => RunCall.parse(c.args[0]));
}

/**
 * タスクの状態を読む
 * @param worker テストの入口
 * @returns 状態
 */
async function statusOf(worker: TestWorker): Promise<unknown> {
  return (await worker.query("DB", `SELECT status FROM nodes WHERE id = '${TASK.nodeId}'`))[0];
}

describe("社員が自分で働き始める", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${TASK.nodeId}', 'task', NULL, 'office', '${TASK.title}', 'パスワードを忘れた人が入れない', 'todo', 1, 'builder', 'build', 'takikou347/know-office', 'president', 0, 0)`,
    );
    await worker.staff("builder", "wake", jst(9));
    await worker.staff("builder", "heartbeat", jst(9, 1));
  }, 30_000);
  afterEach(() => worker.dispose());

  it("タスクを取ると、役のツールと組織の決まりと始めた時の版で、最初の runs を 1 回呼ぶ", async () => {
    expect(await worker.staff("builder", "pull", jst(9, 1))).toEqual({ taken: true, nodeId: TASK.nodeId });
    await until(async () => (await runs(worker)).length > 0);
    const got = await runs(worker);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ nodeId: TASK.nodeId, model: "claude-sonnet-5-5", effort: "medium", tools: [...ROLE_TOOLS.builder] });
    expect(got[0]?.systemPrompt).toBe(`${ORG_RULES}\n\n${BUILDER_PROMPT}`);
    expect(got[0]?.prompt).toContain(TASK.title);
    expect(got[0]?.prompt).toContain("パスワードを忘れた人が入れない");
    expect(got[0]).not.toHaveProperty("resume");
    expect(decodeJwt(got[0]?.ticket ?? "")).toMatchObject({ sub: "builder", node: TASK.nodeId });
    expect(await statusOf(worker)).toEqual({ status: "doing" });
  });

  it("続きの呼び出しは、始めた時の役目の説明文の版で呼ぶ", async () => {
    await worker.staff("builder", "pull", jst(9, 1));
    await until(async () => (await runs(worker)).length > 0);
    // 始めた後に役目の説明文が変わっても、このタスクの続きは始めた時の版で呼ぶ
    await worker.query("DB", `INSERT INTO staff_prompts (id, staff_id, version, body, by, created_at) VALUES ('0190f4a8-0000-7000-8000-00000000f002', 'builder', 2, '新しい版', 'owner', 1)`);
    await worker.query("DB", "UPDATE staff SET prompt_version = 2 WHERE id = 'builder'");
    // ハートビートが途切れて作り直すと、記録が無いので最初から呼び直す
    await worker.staff("builder", "wake", jst(9, 5));
    await until(async () => (await runs(worker)).length > 1);
    expect((await runs(worker))[1]?.systemPrompt).toBe(`${ORG_RULES}\n\n${BUILDER_PROMPT}`);
  });

  it("ワークスペースがもう走っている時は、作業トークンを失効させるだけでタスクは離さない", async () => {
    await worker.workspaceMode("builder", "busy");
    await worker.staff("builder", "pull", jst(9, 1));
    await until(async () => (await worker.query("REC_2030", "SELECT 1 FROM audit_log WHERE action = 'ticket.revoke'")).length > 0);
    expect(await worker.query("REC_2030", "SELECT action FROM audit_log WHERE action = 'ticket.revoke'")).toHaveLength(1);
    expect(await statusOf(worker)).toEqual({ status: "doing" });
    expect(await worker.staff("builder", "status", jst(9, 2))).toMatchObject({ nodeId: TASK.nodeId });
  });

  it("ワークスペースに届かない時は、作業トークンを失効させてタスクを todo に戻し、すぐには取り直さない", async () => {
    await worker.workspaceMode("builder", "down");
    await worker.staff("builder", "pull", jst(9, 1));
    await until(async () => JSON.stringify(await statusOf(worker)) === JSON.stringify({ status: "todo" }));
    expect(await statusOf(worker)).toEqual({ status: "todo" });
    expect(await worker.staff("builder", "status", jst(9, 2))).toMatchObject({ nodeId: null });
    expect(await worker.query("REC_2030", "SELECT action FROM audit_log WHERE action = 'ticket.revoke'")).toHaveLength(1);
  });

  it("続けて 3 回始められなければ、todo に戻さずオーナーの答えを待たせ、通知を 1 件出し、alarm で取り直しても繰り返さない", async () => {
    await worker.workspaceMode("builder", "down");
    for (let n = 1; n <= 3; n += 1) {
      // ハートビートが途切れる 90 秒より前に取り直す
      await worker.staff("builder", "pull", jst(9, 1, n * 10));
      const want = n < 3 ? "todo" : "waiting_owner";
      await until(async () => JSON.stringify(await statusOf(worker)) === JSON.stringify({ status: want }));
    }
    expect(await statusOf(worker)).toEqual({ status: "waiting_owner" });
    expect(await worker.query("DB", "SELECT kind FROM notices WHERE kind = 'staff_run_failed'")).toHaveLength(1);
    // alarm の取り直しは waiting_owner のタスクを取らない
    expect(await worker.staff("builder", "pull", jst(9, 1, 40))).toEqual({ taken: false, nodeId: null });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await worker.query("REC_2030", "SELECT action FROM audit_log WHERE action = 'ticket.issue'")).toHaveLength(3);
  });

  it("鍵の失敗の通知を読むまで、runs を呼ばず、読んだ後の arm で呼ぶ", async () => {
    await worker.query("DB", "INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES ('0190f4a8-0000-7000-8000-00000000e001', 0, 'warn', 'sdk_auth_failed', 'Claude の鍵が断られた', 'x', 'office')");
    await worker.staff("builder", "pull", jst(9, 1));
    await worker.staff("builder", "arm", jst(9, 2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await runs(worker)).toEqual([]);
    expect(await worker.query("REC_2030", "SELECT action FROM audit_log WHERE action = 'ticket.issue'")).toEqual([]);
    await worker.query("DB", "UPDATE notices SET read_at = 1 WHERE kind = 'sdk_auth_failed'");
    await worker.staff("builder", "arm", jst(9, 3));
    await until(async () => (await runs(worker)).length > 0);
    expect(await runs(worker)).toHaveLength(1);
  });

  it("使用の上限の通知を読むまで、runs を呼ばず、読んだ後の arm で呼ぶ", async () => {
    await worker.query("DB", "INSERT INTO notices (id, at, level, kind, title, body, scope) VALUES ('0190f4a8-0000-7000-8000-00000000e002', 0, 'stop', 'claude_spend_limit', 'Claude の API の使用の上限に届いた', 'x', 'office')");
    await worker.staff("builder", "pull", jst(9, 1));
    await worker.staff("builder", "arm", jst(9, 2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await runs(worker)).toEqual([]);
    expect(await worker.query("REC_2030", "SELECT action FROM audit_log WHERE action = 'ticket.issue'")).toEqual([]);
    await worker.query("DB", "UPDATE notices SET read_at = 1 WHERE kind = 'claude_spend_limit'");
    await worker.staff("builder", "arm", jst(9, 3));
    await until(async () => (await runs(worker)).length > 0);
    expect(await runs(worker)).toHaveLength(1);
  });

  it("止めたタスクを離れると、ワークスペースの呼び出しを止めさせ、止め終えた後に次のタスクを取って呼ぶ", async () => {
    const next = "0190f4a8-0000-7000-8000-000000000102";
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${next}', 'task', NULL, 'office', '次のタスク', NULL, 'todo', 2, 'builder', 'build', 'takikou347/know-office', 'president', 0, 0)`,
    );
    await worker.staff("builder", "pull", jst(9, 1));
    await until(async () => (await runs(worker)).length > 0);
    // 止める動きがタスクを stopped にしてから社員 DO に知らせる
    await worker.query("DB", `UPDATE nodes SET status = 'stopped' WHERE id = '${TASK.nodeId}'`);
    await worker.staff("builder", "dropTask", TASK.nodeId, jst(9, 2));
    await until(async () => (await runs(worker)).length > 1);
    const calls = (await worker.workspace("builder")).map((c) => c.method);
    expect(calls.filter((m) => m === "abort")).toHaveLength(1);
    // 止め終えてから次を呼ぶ
    expect(calls.lastIndexOf("run")).toBeGreaterThan(calls.indexOf("abort"));
    expect((await runs(worker)).map((r) => r.nodeId)).toEqual([TASK.nodeId, next]);
    expect(await worker.staff("builder", "status", jst(9, 3))).toMatchObject({ nodeId: next });
  });

  it("止め終える前に新しいタスクの知らせで取らせても、止め終えた後に次のタスクを取って呼ぶ", async () => {
    const next = "0190f4a8-0000-7000-8000-000000000105";
    await worker.staff("builder", "pull", jst(9, 1));
    await until(async () => (await runs(worker)).length > 0);
    await worker.workspaceMode("builder", "abort_hold");
    await worker.query("DB", `UPDATE nodes SET status = 'stopped' WHERE id = '${TASK.nodeId}'`);
    await worker.staff("builder", "dropTask", TASK.nodeId, jst(9, 2));
    // ワークスペースが止め待ちに入ってから、次の知らせを送る
    await until(async () => (await worker.workspace("builder")).some((c) => c.method === "abort"));
    // 止めている間に足されたタスクの知らせ (notifyStaff) が、手の空いた社員に取らせる
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${next}', 'task', NULL, 'office', '次のタスク', NULL, 'todo', 0, 'builder', 'plan', NULL, 'owner', 0, 0)`,
    );
    await worker.staff("builder", "pull", jst(9, 2, 1));
    // 止め終えさせる
    await worker.workspaceMode("builder", "ok");
    const started = async () => z.object({ started: z.boolean() }).loose().parse(await worker.staff("builder", "runState", next)).started;
    await until(started);
    expect(await started()).toBe(true);
    expect(await worker.staff("builder", "status", jst(9, 3))).toMatchObject({ nodeId: next });
    expect(await statusOf(worker)).toEqual({ status: "stopped" });
  });

  it("ワークスペースが中断に答えなくても、エラーログを残して次のタスクを取る", async () => {
    const next = "0190f4a8-0000-7000-8000-000000000103";
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${next}', 'task', NULL, 'office', '次のタスク', NULL, 'todo', 2, 'builder', 'build', 'takikou347/know-office', 'president', 0, 0)`,
    );
    await worker.staff("builder", "pull", jst(9, 1));
    await until(async () => (await runs(worker)).length > 0);
    await worker.workspaceMode("builder", "abort_down");
    await worker.query("DB", `UPDATE nodes SET status = 'stopped' WHERE id = '${TASK.nodeId}'`);
    await worker.staff("builder", "dropTask", TASK.nodeId, jst(9, 2));
    await until(async () => (await runs(worker)).length > 1);
    expect((await runs(worker)).map((r) => r.nodeId)).toEqual([TASK.nodeId, next]);
    expect(await worker.staff("builder", "status", jst(9, 3))).toMatchObject({ nodeId: next });
    const failed = (await worker.errorLogs()).filter((line) => line.includes('"event":"workspace_call_failed"') && line.includes('"call":"abort"'));
    expect(failed).toHaveLength(1);
  });

  it("タスクを取った後に runs を呼ばずに落ちても、arm が見つけて呼ぶ", async () => {
    await worker.query("DB", `UPDATE nodes SET status = 'doing' WHERE id = '${TASK.nodeId}'`);
    // pull を通らずに持たせ、runs を呼ぶ前に DO が落ちた形にする
    await worker.staff("builder", "take", TASK, null, jst(9, 1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await runs(worker)).toEqual([]);
    await worker.staff("builder", "arm", jst(9, 2));
    await until(async () => (await runs(worker)).length > 0);
    expect(await runs(worker)).toHaveLength(1);
    // 走らせた後の arm は重ねて呼ばない
    await worker.staff("builder", "arm", jst(9, 3));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await runs(worker)).toHaveLength(1);
  });
});

describe("社員 DO の最初の alarm", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
  }, 30_000);
  afterEach(() => worker.dispose());

  it("alarm の無い社員 DO に arm で次の始まりの alarm を掛け、掛かっていれば変えない", async () => {
    expect(await worker.staff("builder", "arm", jst(8))).toEqual({ alarm: jst(9) });
    expect(await worker.staff("builder", "arm", jst(8, 30))).toEqual({ alarm: jst(9) });
  });
});

describe("チェックポイントで退勤する", () => {
  const SESSION = "0190f4a8-0000-7000-8000-00000000c101";
  const OTHER = "0190f4a8-0000-7000-8000-000000000104";
  const NEXT_DAY = 24 * 60 * 60_000;
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${TASK.nodeId}', 'task', NULL, 'office', '${TASK.title}', 'パスワードを忘れた人が入れない', 'todo', 1, 'builder', 'build', 'takikou347/know-office', 'president', 0, 0)`,
    );
    await worker.staff("builder", "wake", jst(9));
    await worker.staff("builder", "heartbeat", jst(9, 1));
  }, 30_000);
  afterEach(() => worker.dispose());

  const line = toBase64(new TextEncoder().encode(`{"type":"user","sessionId":"${SESSION}","message":{"role":"user","content":"ログインを直す"}}\n`));

  /** タスクを取り、チェックポイントまでの会話の記録を送り、17 時を過ぎてチェックポイントに届いてタスクを持ったまま退勤する */
  async function clockOutHolding(): Promise<void> {
    expect(await worker.staff("builder", "pull", jst(9, 1))).toEqual({ taken: true, nodeId: TASK.nodeId });
    await until(async () => (await runs(worker)).length > 0);
    await worker.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 0, chunk: line }, jst(16, 59));
    await worker.staff("builder", "heartbeat", jst(16, 59, 30));
    await worker.staff("builder", "checkpoint", { kind: "commit", nodeId: TASK.nodeId }, jst(17, 0, 10));
  }

  it("翌日に続ける", async () => {
    await clockOutHolding();
    expect(await worker.staff("builder", "status", jst(17, 1))).toMatchObject({ state: "off", nodeId: null });
    expect(await worker.query("DB", `SELECT status FROM nodes WHERE id = '${TASK.nodeId}'`)).toEqual([{ status: "todo" }]);
    expect(await worker.query("DB", "SELECT node_id, result FROM work_entries")).toEqual([{ node_id: TASK.nodeId, result: "continued" }]);
    expect(await worker.query("REC_2030", "SELECT node_id, staff_id, at FROM node_events WHERE kind = 'continued'")).toEqual([{ node_id: TASK.nodeId, staff_id: "builder", at: jst(17, 0, 10) }]);

    // 夜の間に、優先度の高いタスクが足される
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${OTHER}', 'task', NULL, 'office', '別のタスク', NULL, 'todo', 0, 'builder', 'build', 'takikou347/know-office', 'president', 1, 1)`,
    );
    // 翌日の始まりに出勤し、前の日に続けたタスクを先に取り、最後の会話の記録から続ける
    await worker.staff("builder", "wake", jst(9) + NEXT_DAY);
    await worker.staff("builder", "heartbeat", jst(9, 1) + NEXT_DAY);
    expect(await worker.staff("builder", "pull", jst(9, 1) + NEXT_DAY)).toEqual({ taken: true, nodeId: TASK.nodeId });
    await until(async () => (await runs(worker)).length > 1);
    const calls = await worker.workspace("builder");
    const restored = calls.filter((c) => c.method === "restore");
    expect(restored.map((c) => c.args[0])).toEqual([{ sessionId: SESSION, transcript: line, nextSeq: 1 }]);
    expect((await runs(worker))[1]).toMatchObject({ nodeId: TASK.nodeId, resume: SESSION });
    expect(await worker.query("DB", `SELECT id, status FROM nodes WHERE kind = 'task' ORDER BY id`)).toEqual([
      { id: TASK.nodeId, status: "doing" },
      { id: OTHER, status: "todo" },
    ]);
  });

  it("時間外に続きのタスクを呼ばれた時も、最後の会話の記録から続ける", async () => {
    await clockOutHolding();
    // ゲートウェイの呼び出しは、タスクを doing にしてから社員 DO に渡す
    await worker.query("DB", `UPDATE nodes SET status = 'doing' WHERE id = '${TASK.nodeId}'`);
    await worker.staff("builder", "call", TASK, jst(21));
    await until(async () => (await runs(worker)).length > 1);
    expect((await worker.workspace("builder")).filter((c) => c.method === "restore")).toHaveLength(1);
    expect((await runs(worker))[1]).toMatchObject({ nodeId: TASK.nodeId, resume: SESSION });
  });
});

describe("記録の D1 が無い年の退勤", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, body, status, priority, assignee, task_kind, repo, created_by, created_at, updated_at) VALUES ('${TASK.nodeId}', 'task', NULL, 'office', '${TASK.title}', NULL, 'doing', 1, 'builder', 'build', 'takikou347/know-office', 'president', 0, 0)`,
    );
  }, 30_000);
  afterEach(() => worker.dispose());

  it("記録の D1 が無い年に退勤しても、社員は止まらず、タスクを todo に戻してエラーログに残す", async () => {
    // テストの workerd は REC_2031 を持たないので、2031 年の出来事は書けない
    const later = 365 * 24 * 60 * 60_000;
    await worker.staff("builder", "wake", jst(9) + later);
    await worker.staff("builder", "take", TASK, null, jst(9, 1) + later);
    await worker.staff("builder", "heartbeat", jst(16, 59, 30) + later);
    await worker.staff("builder", "checkpoint", { kind: "commit", nodeId: TASK.nodeId }, jst(17, 0, 10) + later);
    expect(await worker.staff("builder", "status", jst(17, 1) + later)).toMatchObject({ state: "off", nodeId: null });
    expect(await worker.query("DB", `SELECT status FROM nodes WHERE id = '${TASK.nodeId}'`)).toEqual([{ status: "todo" }]);
    await worker.staff("builder", "heartbeat", jst(17, 2) + later);
    await worker.staff("builder", "wake", jst(17, 3) + later);
    expect((await worker.errorLogs()).some((line) => line.includes('"event":"staff_event_failed"'))).toBe(true);
  });
});
