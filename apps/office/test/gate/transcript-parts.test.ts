// ワークスペースが会話の記録の続きを送る POST /ws/v1/transcript-parts が、作業トークンのタスクの記録として社員 DO に渡り、続きでない通し番号を断る事を確かめる (社員が考えるの 3.2、3.6)
import { toBase64 } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import { routeEgress, type Caller } from "../../src/gate/egress.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { appendTranscript, loadTranscript } from "../../src/gate/work/transcript.ts";
import { jst, NODE, rows, startWork, useGuardWorld } from "../helpers/guard.ts";

const w = useGuardWorld();
const SESSION = "0190f4a8-0000-7000-8000-00000000c001";

/**
 * 会話の記録の続きを送る
 * @param token 作業トークン。null なら付けない
 * @param body 本文
 * @returns 受け手の返事
 */
function sendPart(token: string | null, body: unknown): Promise<Response> {
  const caller: Caller = { staffId: "builder", workspaceId: workspaceIdOf(w.gate.env, "builder") };
  const auth: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
  const init = { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) };
  return routeEgress(new Request("http://gate.internal/ws/v1/transcript-parts", init), w.gate.env, caller, { clock: w.clock, guard: w.gate.deps });
}

/**
 * 文字列を UTF-8 の base64 にする
 * @param text 文字列
 * @returns base64
 */
function b64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

describe("会話の記録の続きを送る", () => {
  it("作業トークンのタスクの記録として暗号にして置き、204 を返す", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    w.clock.advance(jst(9, 1) - w.clock.now());
    expect((await sendPart(token, { sessionId: SESSION, seq: 0, chunk: b64("1 行目\n") })).status).toBe(204);
    expect((await sendPart(token, { sessionId: SESSION, seq: 1, chunk: b64("2 行目\n") })).status).toBe(204);
    expect(await rows(w, "SELECT staff_id, node_id, seq FROM transcript_parts ORDER BY seq")).toEqual([
      { staff_id: "builder", node_id: NODE, seq: 0 },
      { staff_id: "builder", node_id: NODE, seq: 1 },
    ]);
    const listed = await w.d1.FILES.list({ prefix: `transcripts/builder/${NODE}/${SESSION}/` });
    expect(listed.objects).toHaveLength(2);
    expect(await loadTranscript({ db: w.d1.DB, files: w.d1.FILES, master: w.gate.env.MASTER_KEY }, "builder", NODE)).toEqual({ sessionId: SESSION, transcript: b64("1 行目\n2 行目\n"), nextSeq: 2 });
  });

  it("前の続きでない通し番号は 409 で断る", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    const res = await sendPart(token, { sessionId: SESSION, seq: 3, chunk: b64("x") });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "conflict" });
    expect(await rows(w, "SELECT seq FROM transcript_parts")).toEqual([]);
  });

  it("返事が届かずに同じ部分を送り直したら 204 で受け直して行を増やさず、中身が違えば 409 で断る", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    expect((await sendPart(token, { sessionId: SESSION, seq: 0, chunk: b64("1 行目\n") })).status).toBe(204);
    expect((await sendPart(token, { sessionId: SESSION, seq: 0, chunk: b64("1 行目\n") })).status).toBe(204);
    const changed = await sendPart(token, { sessionId: SESSION, seq: 0, chunk: b64("別の 1 行目\n") });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "conflict" });
    expect((await sendPart(token, { sessionId: SESSION, seq: 1, chunk: b64("2 行目\n") })).status).toBe(204);
    expect(await rows(w, "SELECT seq FROM transcript_parts ORDER BY seq")).toEqual([{ seq: 0 }, { seq: 1 }]);
    expect(await loadTranscript({ db: w.d1.DB, files: w.d1.FILES, master: w.gate.env.MASTER_KEY }, "builder", NODE)).toMatchObject({ transcript: b64("1 行目\n2 行目\n"), nextSeq: 2 });
  });

  it("戻す記録が上限を超える時は、R2 から読まずに投げ、中身を出さずに残す", async () => {
    await startWork(w, "builder");
    const store = { db: w.d1.DB, files: w.d1.FILES, master: w.gate.env.MASTER_KEY };
    await appendTranscript(store, "builder", NODE, { sessionId: SESSION, seq: 0, chunk: b64("秘密の 1 行目\n") }, jst(9, 1));
    await appendTranscript(store, "builder", NODE, { sessionId: SESSION, seq: 1, chunk: b64("秘密の 2 行目\n") }, jst(9, 2));
    let reads = 0;
    const files = new Proxy(w.d1.FILES, {
      get: (target, prop, receiver) => {
        if (prop === "get") reads += 1;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limit = new TextEncoder().encode("秘密の 1 行目\n").byteLength + 1;
    await expect(loadTranscript({ ...store, files, maxBytes: limit }, "builder", NODE)).rejects.toMatchObject({ code: "payload_too_large" });
    const lines = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    expect(reads).toBe(0);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ level: "warn", event: "transcript_too_large", staffId: "builder", nodeId: NODE, sessionId: SESSION, parts: 2, bytes: expect.any(Number) as unknown }]);
    expect(lines.join("\n")).not.toContain("秘密");
    // 上限の中なら読める
    expect(await loadTranscript({ ...store, maxBytes: limit * 2 }, "builder", NODE)).toMatchObject({ nextSeq: 2 });
  });

  it("作業トークンが無ければ 401、形の違う入力は 422 で断る", async () => {
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    expect((await sendPart(null, { sessionId: SESSION, seq: 0, chunk: b64("x") })).status).toBe(401);
    // session は R2 の置き場とワークスペースのファイルの名前に入るので、UUID のほかは断る
    for (const bad of [{ sessionId: "../x", seq: 0, chunk: b64("x") }, { sessionId: SESSION, seq: -1, chunk: b64("x") }, { sessionId: SESSION, seq: 0, chunk: "!!" }, { sessionId: SESSION, seq: 0, chunk: "" }]) {
      expect((await sendPart(token, bad)).status).toBe(422);
    }
    expect(await rows(w, "SELECT seq FROM transcript_parts")).toEqual([]);
  });
});
