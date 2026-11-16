// 会話の記録を社員 DO がタスクごとの鍵で暗号にして R2 に置き、ワークスペースが落ちて作り直した後に戻して同じ session の続きを呼ぶ事を、本物の workerd で確かめる (社員が考えるの 3.6、4 章)
import { deriveKey, fromBase64, ORG_RULES, ROLE_TOOLS, toBase64 } from "@know-office/core";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jst, TASK } from "../helpers/staff.ts";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

/** do/wrangler.jsonc の MASTER_KEY */
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const SESSION = "0190f4a8-0000-7000-8000-00000000c001";
/** 会話の記録 (JSONL) の 2 回分の増え */
const LINES = [`{"type":"user","sessionId":"${SESSION}","message":{"role":"user","content":"ログインを直す"}}\n`, `{"type":"assistant","sessionId":"${SESSION}","message":{"role":"assistant","content":"秘密の作業メモ"}}\n`];
const BUILDER_PROMPT = "無いデータを作らず、分からない所は「未確認」と書く。タスクを 1 つずつ取り、ワークスペースで直して試し、プルリクエストを出す。困った時は社長に上げる。";

/**
 * 文字列を UTF-8 の base64 にする
 * @param text 文字列
 * @returns base64
 */
function b64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

/**
 * ワークスペースの代わりが呼ばれるまで待つ。作り直しと続きの呼び出しは、勤務の鎖を止めないよう待たずに頼むので後から届く
 * @param worker テストの入口
 * @param count 待つ呼び出しの数
 * @returns 受けた呼び出し
 */
async function calls(worker: TestWorker, count: number): Promise<{ method: string; args: unknown[] }[]> {
  for (let n = 0; n < 100; n += 1) {
    const got = await worker.workspace("builder");
    if (got.length >= count) return got;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return worker.workspace("builder");
}

/**
 * 待たずに頼んだ後の動きが済むまで待つ
 * @param done 済んだか
 */
async function until(done: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 50 && !(await done()); n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * R2 に置いた物を、タスクの鍵で戻す
 * @param nodeId 鍵を作るタスク
 * @param key R2 の置き場
 * @param body 置いた物の base64
 * @returns 戻した文字列。戻せなければ null
 */
async function open(nodeId: string, key: string, body: string): Promise<string | null> {
  const bytes = fromBase64(body) ?? new Uint8Array();
  const cryptoKey = await deriveKey(MASTER_KEY, "transcript", nodeId);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(key) }, cryptoKey, bytes.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

describe("経過の記憶", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
    await worker.query(
      "DB",
      `INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, task_kind, created_by, created_at, updated_at) VALUES ('${TASK.nodeId}', 'task', NULL, 'office', '${TASK.title}', 'doing', 1, 'builder', 'build', 'president', 0, 0)`,
    );
    await worker.staff("builder", "wake", jst(9));
    await worker.staff("builder", "take", TASK, null, jst(9));
    await worker.staff("builder", "heartbeat", jst(9, 1));
  }, 30_000);
  afterEach(() => worker.dispose());

  /**
   * 会話の記録の増えを 2 回送る
   */
  async function sendTwo(): Promise<void> {
    await worker.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 0, chunk: b64(LINES[0] ?? "") }, jst(9, 2));
    await worker.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 1, chunk: b64(LINES[1] ?? "") }, jst(9, 3));
  }

  it("落ちた後に再開する", async () => {
    // 落ちる前のワークスペースに渡していた作業トークン
    const old = z.object({ jti: z.string() }).parse(await worker.staff("builder", "issueToken", TASK.nodeId, "ws-before", jst(9, 1)));
    expect(await worker.staff("builder", "checkToken", old.jti, "ws-before", jst(9, 2))).toBe("ok");
    await sendTwo();
    // ハートビートが 90 秒届かず、社員 DO がワークスペースを作り直す
    await worker.staff("builder", "wake", jst(9, 5));
    const got = await calls(worker, 4);
    expect(got.map((c) => c.method)).toEqual(["start", "restart", "restore", "run"]);
    expect(got[2]?.args[0]).toEqual({ sessionId: SESSION, transcript: b64(LINES.join("")), nextSeq: 2 });
    const run = got[3]?.args[0];
    expect(run).toMatchObject({ nodeId: TASK.nodeId, resume: SESSION, model: "claude-sonnet-5-5", effort: "medium", systemPrompt: `${ORG_RULES}\n\n${BUILDER_PROMPT}`, tools: [...ROLE_TOOLS.builder] });
    // 続きは、このタスクだけに使える新しい作業トークンで呼ぶ
    const ticket = typeof run === "object" && run !== null && "ticket" in run ? String(run.ticket) : "";
    const claims = z.object({ sub: z.string(), node: z.string(), ws: z.string(), jti: z.string() }).parse(decodeJwt(ticket));
    expect(claims).toMatchObject({ sub: "builder", node: TASK.nodeId });
    // 続きを渡した後は、そのタスクの前の作業トークンを失効させ、監査ログに残す
    await until(async () => (await worker.staff("builder", "checkToken", old.jti, "ws-before", jst(9, 6))) === "revoked");
    expect(await worker.staff("builder", "checkToken", old.jti, "ws-before", jst(9, 6))).toBe("revoked");
    expect(await worker.staff("builder", "checkToken", claims.jti, claims.ws, jst(9, 6))).toBe("ok");
    await until(async () => (await worker.query("REC_2030", "SELECT target FROM audit_log WHERE action = 'ticket.revoke'")).length > 0);
    const revoked = z.array(z.object({ target: z.string(), detail: z.string() })).parse(await worker.query("REC_2030", "SELECT target, detail FROM audit_log WHERE action = 'ticket.revoke'"));
    expect(revoked.map((r) => [r.target, JSON.parse(r.detail) as unknown])).toEqual([[old.jti, { staffId: "builder", nodeId: TASK.nodeId, reason: "resumed" }]]);
  });

  it("会話の記録は R2 にタスクごとの鍵で暗号にして置き、D1 に部分ごとの行を足す", async () => {
    await sendTwo();
    const prefix = `transcripts/builder/${TASK.nodeId}/${SESSION}/`;
    const files = await worker.files(prefix);
    expect(files.map((f) => f.key)).toEqual([`${prefix}0.bin`, `${prefix}1.bin`]);
    for (const [i, file] of files.entries()) {
      const body = file.body ?? "";
      expect(atob(body)).not.toContain("ログイン");
      expect(await open(TASK.nodeId, file.key, body)).toBe(LINES[i]);
      // ほかのタスクの鍵と、ほかの置き場の名前では戻せない
      expect(await open("0190f4a8-0000-7000-8000-000000000002", file.key, body)).toBeNull();
      expect(await open(TASK.nodeId, `${prefix}9.bin`, body)).toBeNull();
    }
    expect(await worker.query("DB", "SELECT staff_id, node_id, session_id, seq, key FROM transcript_parts ORDER BY seq")).toEqual([
      { staff_id: "builder", node_id: TASK.nodeId, session_id: SESSION, seq: 0, key: `${prefix}0.bin` },
      { staff_id: "builder", node_id: TASK.nodeId, session_id: SESSION, seq: 1, key: `${prefix}1.bin` },
    ]);
    expect(await worker.staff("builder", "loadTranscript", TASK.nodeId)).toEqual({ sessionId: SESSION, transcript: b64(LINES.join("")), nextSeq: 2 });
  });

  it("前の続きでない通し番号を断る", async () => {
    await expect(worker.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 1, chunk: b64("x") }, jst(9, 2))).rejects.toThrow(/code=conflict$/);
    await worker.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 0, chunk: b64("x") }, jst(9, 2));
    await expect(worker.staff("builder", "appendTranscript", TASK.nodeId, { sessionId: SESSION, seq: 0, chunk: b64("y") }, jst(9, 3))).rejects.toThrow(/code=conflict$/);
    expect(await worker.query("DB", "SELECT seq FROM transcript_parts")).toEqual([{ seq: 0 }]);
  });

  it("自動停止で止めて作り直した時は、続きを呼ばない", async () => {
    await sendTwo();
    await worker.staff("builder", "heartbeat", jst(9, 4));
    await worker.staff("builder", "halt", jst(9, 4));
    expect((await calls(worker, 2)).map((c) => c.method)).toEqual(["start", "restart"]);
    // 続きを呼ぶなら作り直しのすぐ後に届くので、少し待っても届かない事を見る
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await worker.workspace("builder")).map((c) => c.method)).toEqual(["start", "restart"]);
  });

  it("会話の記録が無いタスクは戻さない", async () => {
    expect(await worker.staff("builder", "loadTranscript", TASK.nodeId)).toBeNull();
  });
});
