// 配信 DO を本物の workerd で確かめる。作業トークンは同時でも 1 回だけ、配った出来事が届き、画面からの送信と多すぎる接続と古い接続を閉じる (社員と自動の 3.7)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LIVE_MAX_AGE_MS, LIVE_MAX_SOCKETS } from "../../src/gate/live/limits.ts";
import { startTestWorker, type TestWorker } from "../helpers/worker.ts";

const NOTICE = { type: "notice", notice: { id: "01a22eaf-c180-7411-9da6-a341454f0f6c" } };

/** 開いた接続と、受けた文、閉じた番号 */
type Opened = { ws: WebSocket; frames: string[]; closed: Promise<number> };

/**
 * 配信 DO に WebSocket を開かせ、開くまで待つ
 * @param worker テストの入口
 * @param session ログインセッションの ID
 * @param at 開いた時刻
 * @returns 接続
 */
async function open(worker: TestWorker, session: string, at = Date.now()): Promise<Opened> {
  const ws = new WebSocket(await worker.liveUrl({ session, ip: "203.0.113.1", at }));
  const frames: string[] = [];
  ws.addEventListener("message", (e) => frames.push(String(e.data)));
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("開けない")));
  });
  return { ws, frames, closed };
}

/**
 * 条件が満たされるまで待つ
 * @param check 確かめる関数
 * @returns 満たされた時
 */
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100 && !check(); n += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("配信 DO", () => {
  let worker: TestWorker;
  beforeEach(async () => {
    worker = await startTestWorker();
  }, 30_000);
  afterEach(() => worker.dispose());

  it("作業トークンは同時に 2 回使っても 1 回だけ通る", async () => {
    const now = Date.now();
    const { ticket } = z.object({ ticket: z.string() }).parse(await worker.live("issue", now));
    const answers = await Promise.all([worker.live("redeem", ticket, now), worker.live("redeem", ticket, now)]);
    expect(answers.map(String).toSorted((a, b) => a.localeCompare(b))).toEqual(["false", "true"]);
  });

  it("配った出来事が開いている接続に届き、画面から送ると 1008 で閉じる", async () => {
    const a = await open(worker, "s1");
    const b = await open(worker, "s2");
    await worker.live("publish", NOTICE);
    await until(() => a.frames.length > 0 && b.frames.length > 0);
    expect(a.frames.map((f) => JSON.parse(f) as unknown)).toEqual([NOTICE]);
    expect(b.frames).toHaveLength(1);
    a.ws.send("hello");
    expect(await a.closed).toBe(1008);
    b.ws.close();
  });

  it("ログインセッションの接続だけを閉じ、全部を閉じる時は今の端末を残す", async () => {
    // RPC で閉じた時の閉じる知らせは wrangler の手元の中継が Node の WebSocket へすぐ渡さないので、閉じた接続にもう配らない事で確かめる
    const a = await open(worker, "s1");
    const b = await open(worker, "s2");
    const c = await open(worker, "s3");
    await worker.live("closeSession", "s1");
    await worker.live("publish", NOTICE);
    await until(() => b.frames.length > 0 && c.frames.length > 0);
    expect([a.frames.length, b.frames.length, c.frames.length]).toEqual([0, 1, 1]);
    await worker.live("closeAll", "s3");
    await worker.live("publish", NOTICE);
    await until(() => c.frames.length > 1);
    expect([a.frames.length, b.frames.length, c.frames.length]).toEqual([0, 1, 2]);
    for (const o of [a, b, c]) o.ws.close();
  });

  // DO が自分から閉じた接続は、wrangler の手元の中継が TCP を閉じず、Node の WebSocket の close が閉じる知らせの約 10 秒後に届く。
  // 閉じた番号は close でしか読めないので、古さで閉じる物と数で閉じる物を 1 つの入口で続けて起こし、2 つの待ちを重ねる
  it(`開いてから 1 時間を過ぎた接続は 1000 で閉じ、${String(LIVE_MAX_SOCKETS + 1)} 本目を開くと最も古い接続を 1008 で閉じる`, async () => {
    const old = await open(worker, "old", Date.now() - LIVE_MAX_AGE_MS - 1);
    // 過ぎた時刻の alarm がすぐ動き、閉じる知らせが届くまで待ってから、数の上限を確かめる
    await until(() => old.ws.readyState >= WebSocket.CLOSING);
    const base = Date.now();
    const opened: Opened[] = [];
    for (let n = 0; n < LIVE_MAX_SOCKETS; n += 1) opened.push(await open(worker, `s${String(n)}`, base + n));
    const extra = await open(worker, "extra", base + LIVE_MAX_SOCKETS);
    expect(await Promise.all([old.closed, opened[0]?.closed])).toEqual([1000, 1008]);
    await worker.live("publish", NOTICE);
    await until(() => extra.frames.length > 0 && opened.slice(1).every((o) => o.frames.length > 0));
    expect(old.frames).toEqual([]);
    expect(opened[0]?.frames).toEqual([]);
    expect(opened.slice(1).every((o) => o.frames.length === 1)).toBe(true);
    for (const o of [...opened.slice(1), extra]) o.ws.close();
  });
});
