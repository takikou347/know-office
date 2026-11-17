// エディタの補完の 1 本の中継の上限と、ワークスペースの起こし方と止め方を確かめる (タスクとレビューの 3.6、社員が考えるの 3.2)
import { health } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { LSP_RELAY_LIMITS, LspRelay } from "../../src/gate/work/lsp-relay.ts";
import { type ContainerLike, WorkspaceBox } from "../../src/gate/work/workspace-box.ts";
import { deferred, type FakeSocket, fakeSocket, ManualTimers } from "../helpers/lsp.ts";

/** 日本時間の 2026-11-17 の 20 時。勤務の外 */
const T0 = Date.UTC(2026, 10, 17, 11);

/**
 * 中継を作る
 * @param timers 時計
 * @returns 中継と両側の接続
 */
function relayWith(timers = new ManualTimers(T0)): { relay: LspRelay; screen: FakeSocket; upstream: FakeSocket; timers: ManualTimers; ended: number[] } {
  const screen = fakeSocket();
  const upstream = fakeSocket();
  const ended: number[] = [];
  const relay = new LspRelay(screen, upstream, { sessionId: "s1", ip: "203.0.113.1", openedAt: timers.now() }, timers, () => void ended.push(1));
  return { relay, screen, upstream, timers, ended };
}


describe("読みやすさと補完", () => {
  it("上りの 1MiB を超える 1 件は 1009、1 分に 601 回目の送りは 1008 で閉じる (1MiB ちょうどと 600 回ちょうどは通す)", () => {
    const big = relayWith();
    big.relay.fromScreen("a".repeat(LSP_RELAY_LIMITS.upBytes));
    expect([big.upstream.sent.length, big.screen.closed]).toEqual([1, null]);
    big.relay.fromScreen("a".repeat(LSP_RELAY_LIMITS.upBytes + 1));
    expect(big.screen.closed?.code).toBe(1009);
    expect(big.upstream.sent).toHaveLength(1);
    // 多バイトの文字はバイトで数える
    const wide = relayWith();
    wide.relay.fromScreen("あ".repeat(LSP_RELAY_LIMITS.upBytes / 3 + 1));
    expect(wide.screen.closed?.code).toBe(1009);

    const many = relayWith();
    for (let n = 0; n < LSP_RELAY_LIMITS.upPerMinute; n += 1) many.relay.fromScreen("{}");
    expect([many.upstream.sent.length, many.screen.closed]).toEqual([600, null]);
    many.relay.fromScreen("{}");
    expect(many.screen.closed?.code).toBe(1008);
    expect(many.upstream.sent).toHaveLength(600);
    // 1 分たてば数え直す
    const later = relayWith();
    for (let n = 0; n < 600; n += 1) later.relay.fromScreen("{}");
    later.timers.advance(60_000);
    later.relay.fromScreen("{}");
    expect(later.screen.closed).toBeNull();
  });

  it("下りの 4MiB を超える 1 件は 1011 で閉じる (4MiB ちょうどは通す)", () => {
    const { relay, screen, upstream } = relayWith();
    relay.fromUpstream("b".repeat(LSP_RELAY_LIMITS.downBytes));
    expect([screen.sent.length, screen.closed]).toEqual([1, null]);
    relay.fromUpstream("b".repeat(LSP_RELAY_LIMITS.downBytes + 1));
    expect(screen.closed?.code).toBe(1011);
    expect(upstream.closed).not.toBeNull();
    expect(screen.sent).toHaveLength(1);
  });

  it("1 時間で閉じ、10 分送りが無ければ閉じる", () => {
    const idle = relayWith();
    idle.timers.advance(LSP_RELAY_LIMITS.idleMs - 1);
    idle.relay.fromScreen("{}");
    idle.timers.advance(LSP_RELAY_LIMITS.idleMs - 1);
    expect(idle.screen.closed).toBeNull();
    idle.timers.advance(1);
    expect(idle.screen.closed?.code).toBe(1000);
    expect(idle.upstream.closed).not.toBeNull();
    expect(idle.ended).toEqual([1]);
    // 送り続けても 1 時間で閉じる
    const old = relayWith();
    for (let m = 0; m < 59; m += 1) {
      old.timers.advance(60_000);
      old.relay.fromScreen("{}");
    }
    old.timers.advance(59_999);
    expect(old.screen.closed).toBeNull();
    old.timers.advance(1);
    expect(old.screen.closed?.code).toBe(1000);
  });

  it("画面の文字でない送りは 1003 で閉じ、ワークスペースが閉じたら画面も閉じる", () => {
    const binary = relayWith();
    binary.relay.fromScreen(new ArrayBuffer(4));
    expect(binary.screen.closed?.code).toBe(1003);
    const down = relayWith();
    down.relay.upstreamClosed(1011);
    expect(down.screen.closed?.code).toBe(1011);
    // 理由の無い閉じ方は送り返せないので 1011 にする
    const abnormal = relayWith();
    abnormal.relay.upstreamClosed(1006);
    expect(abnormal.screen.closed?.code).toBe(1011);
  });

});

/**
 * 止めるのを合図まで待つコンテナの代わりを作る
 * @returns コンテナ、止めるのを終わらせる関数、起こした回数
 */
function slowContainer(): { container: ContainerLike<null>; release: () => void; starts: number[] } {
  const gate = deferred();
  const starts: number[] = [];
  let running = true;
  const container: ContainerLike<null> = {
    get running() {
      return running;
    },
    intercepts: false,
    start: () => {
      starts.push(1);
      running = true;
    },
    interceptOutboundHttp: () => Promise.resolve(),
    interceptOutboundHttps: () => Promise.resolve(),
    getTcpPort: () => ({ fetch: () => Promise.resolve(Response.json({ data: health("workspace") })) }),
    destroy: async () => {
      await gate.promise;
      running = false;
    },
  };
  return { container, release: gate.resolve, starts };
}

describe("ワークスペースの起こし方と止め方", () => {
  it("止める最中に start が来ても、最後はワークスペースが動いている", async () => {
    const { container, release, starts } = slowContainer();
    let key: string | undefined = "a".repeat(64);
    const box = new WorkspaceBox(container, () => null, { staffId: "builder", workspaceId: "ws-builder" }, {
      wait: () => Promise.resolve(),
      keys: { get: () => Promise.resolve(key), put: (k) => Promise.resolve(void (key = k)) },
      notifyDown: () => Promise.resolve(),
    });
    const stopping = box.stop();
    const starting = box.start();
    release();
    await Promise.all([stopping, starting]);
    expect(container.running).toBe(true);
    expect(starts).toHaveLength(1);
  });

  it("補完のために起こすのは 1 回だけで、起きなくても通知を出さない", async () => {
    const downs: number[] = [];
    let started = 0;
    const container: ContainerLike<null> = {
      running: false,
      intercepts: false,
      start: () => void (started += 1),
      interceptOutboundHttp: () => Promise.resolve(),
      interceptOutboundHttps: () => Promise.resolve(),
      getTcpPort: () => ({ fetch: () => Promise.reject(new Error("届かない")) }),
      destroy: () => Promise.resolve(),
    };
    const box = new WorkspaceBox(container, () => null, { staffId: "builder", workspaceId: "ws-builder" }, {
      wait: () => Promise.resolve(),
      keys: { get: () => Promise.resolve(undefined), put: () => Promise.resolve() },
      notifyDown: () => Promise.resolve(void downs.push(1)),
    });
    await expect(box.wakeOnce()).rejects.toMatchObject({ code: "unavailable" });
    expect([started, downs.length]).toEqual([1, 0]);
  });

  it("補完の切り替えは 10 秒で諦めるが、切り替えた後の接続は期限で切らない", async () => {
    const signals: AbortSignal[] = [];
    let answer: "now" | "never" = "now";
    const container: ContainerLike<null> = {
      running: true,
      intercepts: false,
      start: () => undefined,
      interceptOutboundHttp: () => Promise.resolve(),
      interceptOutboundHttps: () => Promise.resolve(),
      getTcpPort: () => ({
        fetch: (_url: string, init?: RequestInit) => {
          const signal = init?.signal;
          if (!signal) return Promise.reject(new Error("期限が無い"));
          signals.push(signal);
          // workerd は 101 を返すが、Node の Response は 101 を作れないので 200 で代える
          if (answer === "now") return Promise.resolve(new Response(null, { status: 200 }));
          return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("切った"))));
        },
      }),
      destroy: () => Promise.resolve(),
    };
    const timers = new ManualTimers(T0);
    const box = new WorkspaceBox(container, () => null, { staffId: "builder", workspaceId: "ws-builder" }, {
      wait: () => Promise.resolve(),
      keys: { get: () => Promise.resolve("a".repeat(64)), put: () => Promise.resolve() },
      notifyDown: () => Promise.resolve(),
      after: timers.after,
    });
    const sha = "c".repeat(40);
    await box.connectLsp("0190f4a8-0000-7000-8000-000000000101", sha);
    timers.advance(60 * 60_000);
    expect(signals[0]?.aborted).toBe(false);
    // 切り替えが返らなければ 10 秒で切る
    answer = "never";
    const opening = box.connectLsp("0190f4a8-0000-7000-8000-000000000101", sha).then(() => "つながった", (e: unknown) => (e instanceof Error && "code" in e ? String(e.code) : ""));
    await new Promise((resolve) => setImmediate(resolve));
    timers.advance(10_000 - 1);
    expect(signals[1]?.aborted).toBe(false);
    timers.advance(1);
    expect(signals[1]?.aborted).toBe(true);
    expect(await opening).toBe("unavailable");
  });
});
