// 画面の配信。切れたら新しい作業トークンで待ちを倍にしてつなぎ直し、知らない形は捨てて受け続け、同じ印で読み直しを重ねない (社員と自動の 3.7)
import type { LiveEvent } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { type LiveDeps, liveTickCounter, MARK_MEMORY, markReloader, RETRY_FIRST_MS, RETRY_MAX_MS, runLive, type SocketLike } from "../../src/screen/parts/live.tsx";

const NOTICE = "01a22eaf-c180-7411-9da6-a341454f0f6c";
const OTHER = "01a22eaf-c180-7809-93bb-887b2a06b445";

/** 手で進めるソケット */
type FakeSocket = SocketLike & { closed: boolean; ticket: string; emit: (type: "open" | "close" | "message", data?: unknown) => void };

/**
 * 待っている処理を 1 回進める
 * @returns 進んだ時
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 手で進める配信の口
 * @param tickets 順に出す作業トークン。null は出せない、Error は投げる
 * @returns 口と、開いたソケット、待った長さ、出した作業トークン
 */
function fakeLive(tickets: (string | null | Error)[]) {
  const sockets: FakeSocket[] = [];
  const waits: number[] = [];
  const asked: string[] = [];
  const calls = { ticket: 0 };
  let release: (() => void) | null = null;
  const deps: LiveDeps = {
    ticket: () => {
      calls.ticket += 1;
      const next = tickets.shift() ?? null;
      if (next instanceof Error) return Promise.reject(next);
      if (next !== null) asked.push(next);
      return Promise.resolve(next);
    },
    open: (ticket) => {
      const handlers: { type: string; listener: (e: { data?: unknown }) => void }[] = [];
      const s: FakeSocket = {
        closed: false,
        ticket,
        addEventListener: (type, listener) => handlers.push({ type, listener }),
        close: () => {
          s.closed = true;
        },
        emit: (type, data) => {
          for (const h of handlers) if (h.type === type) h.listener({ data });
        },
      };
      sockets.push(s);
      return s;
    },
    wait: (ms) => {
      waits.push(ms);
      return new Promise<void>((resolve) => (release = resolve));
    },
  };
  const go = async () => {
    const r = release;
    release = null;
    r?.();
    await tick();
  };
  return { deps, sockets, waits, asked, calls, go };
}

describe("配信をつなぎ直す", () => {
  it("切れるたびに新しい作業トークンを出させ、待ちを倍にして上限で止め、つながったら最初の待ちに戻す", async () => {
    const f = fakeLive(["t1", null, new Error("down"), "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    const states: boolean[] = [];
    const stop = runLive(f.deps, () => {}, (c) => states.push(c));
    await tick();
    f.sockets[0]?.emit("open");
    f.sockets[0]?.emit("close");
    await tick();
    // 作業トークンを出せない時と投げた時も、待ってからやり直す
    await f.go();
    await f.go();
    await f.go();
    for (let n = 0; n < 6; n += 1) {
      f.sockets.at(-1)?.emit("close");
      await tick();
      await f.go();
    }
    expect(f.asked).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    expect(f.sockets.map((s) => s.ticket)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
    expect(f.waits.slice(0, 8)).toEqual([RETRY_FIRST_MS, 2000, 4000, 8000, 16_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
    expect(states.slice(0, 2)).toEqual([true, false]);
    f.sockets.at(-1)?.emit("open");
    f.sockets.at(-1)?.emit("close");
    await tick();
    expect(f.waits.at(-1)).toBe(RETRY_FIRST_MS);
    stop();
  });

  it("閉じたら今の接続を閉じ、つなぎ直さない", async () => {
    const f = fakeLive(["t1", "t2"]);
    const stop = runLive(f.deps, () => {}, () => {});
    await tick();
    stop();
    expect(f.sockets[0]?.closed).toBe(true);
    f.sockets[0]?.emit("close");
    await tick();
    await f.go();
    expect(f.sockets).toHaveLength(1);
  });

  it("開いてすぐ閉じた時 (開発の StrictMode の付け外し) は、作業トークンを出させない", async () => {
    const f = fakeLive(["t1"]);
    runLive(f.deps, () => {}, () => {})();
    await tick();
    expect(f.calls.ticket).toBe(0);
    expect(f.sockets).toHaveLength(0);
  });

  it("形の違う出来事は捨てて、その後も受け続ける", async () => {
    const f = fakeLive(["t1"]);
    const got: LiveEvent[] = [];
    const stop = runLive(f.deps, (e) => got.push(e), () => {});
    await tick();
    const s = f.sockets[0];
    s?.emit("message", "{not json");
    s?.emit("message", JSON.stringify({ type: "unknown" }));
    s?.emit("message", JSON.stringify({ type: "notice", notice: { id: NOTICE, title: "余計なキー" } }));
    s?.emit("message", new ArrayBuffer(4));
    s?.emit("message", JSON.stringify({ type: "notice", notice: { id: NOTICE } }));
    expect(got).toEqual([{ type: "notice", notice: { id: NOTICE } }]);
    stop();
  });
});

describe("印で読み直す", () => {
  it("同じ印を 2 回受けても読み直しは 1 回、読み直している間の印はまとめて 1 回だけ後で読む", async () => {
    let calls = 0;
    let finish: (() => void) | null = null;
    const reload = markReloader(() => {
      calls += 1;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    reload(NOTICE);
    reload(NOTICE);
    expect(calls).toBe(1);
    reload(OTHER);
    reload(OTHER);
    expect(calls).toBe(1);
    const first = finish as (() => void) | null;
    first?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    const second = finish as (() => void) | null;
    second?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it("読み直しが失敗しても、次の印でまた読む", async () => {
    let calls = 0;
    const reload = markReloader(() => {
      calls += 1;
      return Promise.reject(new Error("down"));
    });
    reload(NOTICE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    reload(OTHER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it("覚える印は直近の数までにし、古い印はまた読む", async () => {
    let calls = 0;
    const reload = markReloader(() => {
      calls += 1;
      return Promise.resolve();
    });
    for (let n = 0; n <= MARK_MEMORY; n += 1) {
      reload(`id-${String(n)}`);
      await tick();
    }
    expect(calls).toBe(MARK_MEMORY + 1);
    // 直近の物は重ねず、一番古い物は忘れているのでまた読む
    reload(`id-${String(MARK_MEMORY)}`);
    await tick();
    expect(calls).toBe(MARK_MEMORY + 1);
    reload("id-0");
    await tick();
    expect(calls).toBe(MARK_MEMORY + 2);
  });
});

/**
 * 社員の様子の印
 * @param state 社員の状態
 * @returns 印
 */
const staff = (state: "working" | "off"): LiveEvent => ({ type: "staff", staff: { id: "builder", state, nodeId: null } });

describe("出来事で読み直す数", () => {
  it("社員が前と同じ状態に戻っても、そのたびに読み直す", () => {
    const count = liveTickCounter();
    expect([staff("working"), staff("off"), staff("working")].map(count)).toEqual([true, true, true]);
  });

  it("木の印は毎回、通知と発言の同じ印は 1 回だけ数える", () => {
    const count = liveTickCounter();
    const node: LiveEvent = { type: "node", node: { id: NOTICE } };
    const notice: LiveEvent = { type: "notice", notice: { id: NOTICE } };
    const message: LiveEvent = { type: "message", message: { id: OTHER, at: "2026-11-16T00:00:00.000Z", staffId: "builder", nodeId: null, sender: "owner", body: "a", truncated: false } };
    expect([node, node, notice, notice, message, message].map(count)).toEqual([true, true, true, false, true, false]);
  });
});
