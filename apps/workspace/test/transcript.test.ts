// ワークスペースが SDK の会話の記録 (JSONL) の増えた分をゲートウェイに送り、落ちた後は戻した記録の続きから送る事を確かめる (社員が考えるの 3.2、3.6)
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Fetcher, TRANSCRIPT_PART_BYTES, TranscriptPartInput } from "@know-office/core";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFile, TranscriptShipper } from "../src/transcript.ts";

const SESSION = "0190f4a8-0000-7000-8000-00000000c001";
const WORK = "/work";

/** ゲートウェイが受けた部分 */
type Sent = { url: string; auth: string | null; seq: number; text: string };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 空のホームを作る。テストの後に消す
 * @returns ホームの道
 */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ko-transcript-"));
  dirs.push(dir);
  return dir;
}

/**
 * 受けた部分を並べ、決めた答えを返すゲートウェイの代わりを作る
 * @param status 返すステータス
 * @returns fetch の代わりと受けた部分
 */
function gate(status = 204): { fetcher: Fetcher; sent: Sent[]; answer: { status: number } } {
  const sent: Sent[] = [];
  const answer = { status };
  const fetcher: Fetcher = (url, init) => {
    // 送った形がゲートウェイの入力に合うかも見る
    const body = TranscriptPartInput.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    if (answer.status === 204) sent.push({ url, auth: new Headers(init?.headers).get("authorization"), seq: body.seq, text: Buffer.from(body.chunk, "base64").toString("utf8") });
    return Promise.resolve(new Response(null, { status: answer.status }));
  };
  return { fetcher, sent, answer };
}

/**
 * SDK が書く会話の記録に行を足す
 * @param dir ホーム
 * @param text 足す文字
 */
function write(dir: string, text: string): void {
  const file = sessionFile(dir, WORK, SESSION);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

describe("会話の記録を送る", () => {
  it("SDK が書いた記録の増えた分を、行の終わりまで通し番号を付けて作業トークンで送る", async () => {
    const dir = home();
    const { fetcher, sent } = gate();
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK });
    write(dir, '{"n":1}\n{"n":2}\n');
    await shipper.flush(SESSION, "ticket-1");
    // 書きかけの行は、書き終わるまで送らない
    write(dir, '{"n":3}\n{"n":');
    await shipper.flush(SESSION, "ticket-2");
    await shipper.flush(SESSION, "ticket-2");
    write(dir, "4}\n");
    await shipper.flush(SESSION, "ticket-2");
    expect(sent).toEqual([
      { url: "http://gate.internal/ws/v1/transcript-parts", auth: "Bearer ticket-1", seq: 0, text: '{"n":1}\n{"n":2}\n' },
      { url: "http://gate.internal/ws/v1/transcript-parts", auth: "Bearer ticket-2", seq: 1, text: '{"n":3}\n' },
      { url: "http://gate.internal/ws/v1/transcript-parts", auth: "Bearer ticket-2", seq: 2, text: '{"n":4}\n' },
    ]);
  });

  it("512KiB を超える増えは、行の終わりで分けて送る", async () => {
    const dir = home();
    const { fetcher, sent } = gate();
    const line = `${"a".repeat(1023)}\n`;
    write(dir, line.repeat(TRANSCRIPT_PART_BYTES / 1024 + 10));
    await new TranscriptShipper({ fetcher, home: dir, cwd: WORK }).flush(SESSION, "ticket-1");
    expect(sent.map((s) => [s.seq, Buffer.byteLength(s.text)])).toEqual([
      [0, TRANSCRIPT_PART_BYTES],
      [1, 10 * 1024],
    ]);
  });

  it("送れなければ投げ、次は同じ所から同じ通し番号で送り直す", async () => {
    const dir = home();
    const { fetcher, sent, answer } = gate(503);
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK });
    write(dir, '{"n":1}\n');
    await expect(shipper.flush(SESSION, "ticket-1")).rejects.toThrow(/503/);
    answer.status = 204;
    await shipper.flush(SESSION, "ticket-1");
    expect(sent.map((s) => [s.seq, s.text])).toEqual([[0, '{"n":1}\n']]);
  });

  it("戻した記録を SDK の置き場に書き、その続きから次の通し番号で送る", async () => {
    const dir = home();
    const { fetcher, sent } = gate();
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK });
    await shipper.restore({ sessionId: SESSION, transcript: Buffer.from('{"n":1}\n{"n":2}\n').toString("base64"), nextSeq: 2 });
    expect(readFileSync(sessionFile(dir, WORK, SESSION), "utf8")).toBe('{"n":1}\n{"n":2}\n');
    await shipper.flush(SESSION, "ticket-1");
    expect(sent).toEqual([]);
    write(dir, '{"n":3}\n');
    await shipper.flush(SESSION, "ticket-1");
    expect(sent.map((s) => [s.seq, s.text])).toEqual([[2, '{"n":3}\n']]);
  });

  it("戻した会話の記録は、置き場もファイルも staff の持ち物にする", async () => {
    const dir = home();
    const { fetcher } = gate();
    const owned: string[] = [];
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK, own: (path) => Promise.resolve(void owned.push(path)) });
    await shipper.restore({ sessionId: SESSION, transcript: Buffer.from('{"n":1}\n').toString("base64"), nextSeq: 1 });
    const file = sessionFile(dir, WORK, SESSION);
    expect(owned).toEqual([join(dir, ".claude"), join(dir, ".claude", "projects"), dirname(file), file]);
  });

  it("SDK の置き場は、動く置き場の名前の記号を - にした所", () => {
    expect(sessionFile("/home/staff", "/work", SESSION)).toBe(`/home/staff/.claude/projects/-work/${SESSION}.jsonl`);
  });

  it("記録がまだ無い session は送らない", async () => {
    const { fetcher, sent } = gate();
    await new TranscriptShipper({ fetcher, home: home(), cwd: WORK }).flush(SESSION, "ticket-1");
    expect(sent).toEqual([]);
  });
});
