// エディタの補完の中継と、補完で起こしたワークスペースの止め方を、DO の中身の物で確かめる。ルートは lsp.test.ts (タスクとレビューの 3.6、社員が考えるの 3.2)
import { health } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { EDITOR_LIMITS, EditorLsp, type LspBox } from "../../src/gate/work/editor-lsp.ts";
import { LSP_RELAY_LIMITS, LspRelay, type RelaySocket, type RelayTimers } from "../../src/gate/work/lsp-relay.ts";
import { type ContainerLike, WorkspaceBox } from "../../src/gate/work/workspace-box.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const SHA = "c".repeat(40);
const OLD = "d".repeat(40);
/** 日本時間の 2026-11-17 の 20 時。勤務の外 */
const T0 = Date.UTC(2026, 10, 17, 11);

/** 手で進める時計と、時間が来たら呼ぶ物 */
class ManualTimers implements RelayTimers {
  at = T0;
  #tasks: { at: number; fn: () => void; id: number }[] = [];
  #serial = 0;
  now = (): number => this.at;
  after = (ms: number, fn: () => void): (() => void) => {
    const id = (this.#serial += 1);
    this.#tasks.push({ at: this.at + ms, fn, id });
    return () => {
      this.#tasks = this.#tasks.filter((t) => t.id !== id);
    };
  };
  /**
   * 時計を進め、来た物を順に呼ぶ
   * @param ms 進める長さ
   */
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      const due = this.#tasks.filter((t) => t.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#tasks = this.#tasks.filter((t) => t.id !== due.id);
      this.at = due.at;
      due.fn();
    }
    this.at = end;
  }
}

/** 送った物と閉じた番号を覚える接続 */
type FakeSocket = RelaySocket & { sent: string[]; closed: { code: number; reason: string } | null };

/**
 * 接続の代わりを作る
 * @returns 接続
 */
function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closed: null,
    send: (data) => void socket.sent.push(data),
    close: (code, reason) => {
      socket.closed ??= { code, reason };
    },
  };
  return socket;
}

/**
 * 合図で終わる約束を作る
 * @returns 約束と終わらせる関数
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** ワークスペースの代わり。起こした回数、止めた回数、木の受け取りを覚える */
type FakeBox = LspBox & { wakes: number; stops: number; puts: string[]; trees: Map<string, string>; wakeFails: boolean; stopGate: Promise<void> | null; putFails: boolean; isRunning: boolean };

/**
 * ワークスペースの代わりを作る
 * @param running 初めから動いているか
 * @returns 代わり
 */
function fakeBox(running = false): FakeBox {
  let stopping: Promise<void> | null = null;
  const box: FakeBox = {
    isRunning: running,
    get running() {
      return box.isRunning;
    },
    wakes: 0,
    stops: 0,
    puts: [],
    trees: new Map(),
    wakeFails: false,
    stopGate: null,
    putFails: false,
    settled: async () => {
      await stopping;
    },
    wakeOnce: async () => {
      await stopping;
      box.wakes += 1;
      if (box.wakeFails) throw Object.assign(new Error("起きない"), { code: "unavailable" });
      box.isRunning = true;
    },
    stop: async () => {
      box.stops += 1;
      stopping = (async () => {
        await box.stopGate;
        box.isRunning = false;
      })();
      await stopping;
      stopping = null;
    },
    lspTreeSha: (nodeId) => Promise.resolve(box.trees.get(nodeId) ?? null),
    putLspTree: async (nodeId, sha, body) => {
      await new Response(body).arrayBuffer();
      if (box.putFails) throw Object.assign(new Error("木を断った"), { code: "upstream_failed" });
      box.puts.push(`${nodeId}:${sha}`);
      box.trees.set(nodeId, sha);
    },
  };
  return box;
}

/**
 * 手元の記憶を作る
 * @returns 記憶
 */
function memory(): { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } {
  const map = new Map<string, unknown>();
  return { get: (key) => Promise.resolve(structuredClone(map.get(key))), put: (key, value) => Promise.resolve(void map.set(key, structuredClone(value))) };
}

/**
 * 補完の中身を作る
 * @param box ワークスペースの代わり
 * @returns 中身、時計、掛けた alarm
 */
function editorWith(box: FakeBox): { editor: EditorLsp; timers: ManualTimers; alarms: number[]; ended: string[] } {
  const timers = new ManualTimers();
  const alarms: number[] = [];
  const ended: string[] = [];
  const editor = new EditorLsp({ box, storage: memory(), timers, setAlarm: (at) => Promise.resolve(void alarms.push(at)), onRelayEnd: (meta) => void ended.push(meta.sessionId) });
  return { editor, timers, alarms, ended };
}

/**
 * 中継を作る
 * @param timers 時計
 * @returns 中継と両側の接続
 */
function relayWith(timers = new ManualTimers()): { relay: LspRelay; screen: FakeSocket; upstream: FakeSocket; timers: ManualTimers; ended: number[] } {
  const screen = fakeSocket();
  const upstream = fakeSocket();
  const ended: number[] = [];
  const relay = new LspRelay(screen, upstream, { sessionId: "s1", ip: "203.0.113.1", openedAt: timers.now() }, timers, () => void ended.push(1));
  return { relay, screen, upstream, timers, ended };
}

/**
 * 1 本つなぐまでを進める。支度して、要るなら木を渡し、中継を付ける
 * @param editor 補完の中身
 * @param now 時刻
 * @param wake 起こしてよいか
 * @param sessionId ログインセッション
 * @returns 画面の側の接続
 */
async function connect(editor: EditorLsp, now: number, wake = true, sessionId = "s1"): Promise<FakeSocket & { relay: LspRelay }> {
  const prepared = await editor.prepare({ nodeId: NODE, sha: SHA, wake, now });
  if (prepared.tree === "needed") await editor.putTree(NODE, SHA, new Response("木").body ?? new ReadableStream());
  const screen = fakeSocket();
  return Object.assign(screen, { relay: editor.attach(screen, fakeSocket(), { sessionId, ip: "203.0.113.1", openedAt: now }) });
}

/**
 * 画面から 5 分ごとに送りながら時計を進め、接続を開いたままにする
 * @param screen 開いた接続
 * @param screen.relay 中継
 * @param timers 時計
 * @param ms 進める長さ
 */
function keepOpen(screen: { relay: LspRelay }, timers: ManualTimers, ms: number): void {
  for (let left = ms; left > 0; left -= Math.min(left, 5 * 60_000)) {
    timers.advance(Math.min(left, 5 * 60_000));
    screen.relay.fromScreen("{}");
  }
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

  it("同じ session で 2 本を同時に開くと、木を渡すのは 1 度で、新しい接続を受けてから前の接続を 1008 で閉じる", async () => {
    const box = fakeBox(true);
    box.trees.set(NODE, OLD);
    const { editor } = editorWith(box);
    const pa = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    const pb = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    // 1 本目だけが木を取りに行き、2 本目は 1 本目が渡し終えるのを待つ
    expect((await pa).tree).toBe("needed");
    await editor.putTree(NODE, SHA, new Response("木").body ?? new ReadableStream());
    expect((await pb).tree).toBe("ready");
    expect(box.puts).toEqual([`${NODE}:${SHA}`]);
    const first = fakeSocket();
    const firstUp = fakeSocket();
    editor.attach(first, firstUp, { sessionId: "s1", ip: "203.0.113.1", openedAt: T0 });
    const second = fakeSocket();
    editor.attach(second, fakeSocket(), { sessionId: "s1", ip: "203.0.113.1", openedAt: T0 });
    expect(first.closed?.code).toBe(1008);
    expect(firstUp.closed).not.toBeNull();
    expect(second.closed).toBeNull();
  });

  it("木を渡すのに落ちたら、待っていた接続は自分で取りに行く", async () => {
    const box = fakeBox(true);
    const { editor } = editorWith(box);
    const pa = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    const pb = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    expect((await pa).tree).toBe("needed");
    await editor.dropTree(NODE, SHA);
    expect((await pb).tree).toBe("needed");
  });

  it("tarball を取るのが 1 時間 20 回、1 日 100 回に届いていれば 429 (20 回目は通す)", async () => {
    const box = fakeBox(true);
    const { editor, timers } = editorWith(box);
    /**
     * 新しい先の木を 1 回取らせる
     * @param n 何回目か
     * @returns 答えか誤りの code
     */
    const pull = async (n: number): Promise<string> => {
      const sha = n.toString(16).padStart(40, "0");
      try {
        const p = await editor.prepare({ nodeId: NODE, sha, wake: true, now: timers.now() });
        if (p.tree === "needed") await editor.putTree(NODE, sha, new Response("木").body ?? new ReadableStream());
        return p.tree;
      } catch (error) {
        return String((error as { code?: string }).code);
      }
    };
    for (let n = 1; n <= EDITOR_LIMITS.pullsPerHour; n += 1) expect(await pull(n)).toBe("needed");
    expect(await pull(21)).toBe("rate_limited");
    // 1 時間たてば次の 20 回を通し、1 日で 100 回まで
    for (let h = 1; h < 5; h += 1) {
      timers.advance(3_600_000);
      for (let n = 0; n < 20; n += 1) expect(await pull(100 * h + n)).toBe("needed");
    }
    timers.advance(3_600_000);
    expect(await pull(999)).toBe("rate_limited");
    timers.advance(24 * 3_600_000);
    expect(await pull(1000)).toBe("needed");
  });

  it("ワークスペースに今の先の木がある時は tarball を取らない", async () => {
    const box = fakeBox(true);
    box.trees.set(NODE, SHA);
    const { editor } = editorWith(box);
    expect((await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 })).tree).toBe("ready");
  });

  it("ログアウト、全部のログアウト、送信元の締め出し、全体の停止の閉じ方は、合う接続だけを 1008 で閉じる", async () => {
    const box = fakeBox(true);
    box.trees.set(NODE, SHA);
    const { editor, ended } = editorWith(box);
    const a = await connect(editor, T0, true, "s1");
    editor.close({ sessionId: "s2" });
    editor.close({ ip: "198.51.100.1" });
    editor.close({ except: "s1" });
    expect(a.closed).toBeNull();
    editor.close({ sessionId: "s1" });
    expect(a.closed?.code).toBe(1008);
    expect(ended).toEqual(["s1"]);
    const b = await connect(editor, T0, true, "s2");
    editor.close({ ip: "203.0.113.1" });
    expect(b.closed?.code).toBe(1008);
    const c = await connect(editor, T0, true, "s3");
    editor.close({ except: null });
    expect(c.closed?.code).toBe(1008);
  });
});

describe("ワークスペースを起こす時", () => {
  it("勤務の外に起こせない時は起こさずに 503", async () => {
    const box = fakeBox();
    const { editor } = editorWith(box);
    await expect(editor.prepare({ nodeId: NODE, sha: SHA, wake: false, now: T0 })).rejects.toMatchObject({ code: "unavailable" });
    expect(box.wakes).toBe(0);
  });

  it("EDITOR_WAKE が on なら 1 回だけ起こし、起きなければやり直さずに 503", async () => {
    const box = fakeBox();
    box.wakeFails = true;
    const { editor, alarms } = editorWith(box);
    await expect(editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 })).rejects.toMatchObject({ code: "unavailable" });
    expect(box.wakes).toBe(1);
    expect(alarms).toEqual([]);
    box.wakeFails = false;
    const woke = await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    expect([woke.woke, box.wakes]).toEqual([true, 2]);
  });

  it("勤務の外に起こした時間が 1 日 2 時間に届いていれば 429", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers } = editorWith(box);
    // 1 時間ずつ 2 回起こして止める
    for (let n = 0; n < 2; n += 1) {
      await connect(editor, timers.now());
      timers.advance(EDITOR_LIMITS.wakeMs);
      await editor.alarm(timers.now());
      expect(box.running).toBe(false);
    }
    await expect(editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: timers.now() })).rejects.toMatchObject({ code: "rate_limited" });
    expect(box.wakes).toBe(2);
    // 次の日は起こす
    timers.advance(24 * 3_600_000);
    expect((await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: timers.now() })).woke).toBe(true);
  });

  it("補完で起こしたワークスペースは接続が無くなって 10 分で止まる", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers, alarms } = editorWith(box);
    const screen = await connect(editor, T0);
    timers.advance(5 * 60_000);
    editor.close({ sessionId: "s1" });
    expect(screen.closed).not.toBeNull();
    expect(alarms.at(-1)).toBe(timers.now() + EDITOR_LIMITS.idleMs);
    timers.advance(EDITOR_LIMITS.idleMs - 1);
    await editor.alarm(timers.now());
    expect(box.stops).toBe(0);
    timers.advance(1);
    await editor.alarm(timers.now());
    expect([box.stops, box.running]).toEqual([1, false]);
  });

  it("補完で起こしたワークスペースは接続が開いていても起こしてから 1 時間で止まる", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers, alarms, ended } = editorWith(box);
    const screen = await connect(editor, T0);
    expect(alarms).toContain(T0 + EDITOR_LIMITS.wakeMs);
    keepOpen(screen, timers, EDITOR_LIMITS.wakeMs - 1);
    await editor.alarm(timers.now());
    expect(box.stops).toBe(0);
    timers.advance(1);
    await editor.alarm(timers.now());
    expect(box.stops).toBe(1);
    // 中継も同じ時に 1 時間で閉じる
    expect(screen.closed).not.toBeNull();
    expect(ended).toEqual(["s1"]);
  });

  it("1 日の予算を使い切ったら接続が開いていても止まる", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers, alarms } = editorWith(box);
    // 1 時間と 40 分を使っておく
    await connect(editor, timers.now());
    timers.advance(EDITOR_LIMITS.wakeMs);
    await editor.alarm(timers.now());
    await connect(editor, timers.now());
    timers.advance(30 * 60_000);
    editor.close({ except: null });
    timers.advance(EDITOR_LIMITS.idleMs);
    await editor.alarm(timers.now());
    expect(box.stops).toBe(2);
    // 残りは 20 分
    const start = timers.now();
    const screen = await connect(editor, start);
    expect(alarms.at(-1)).toBe(start + 20 * 60_000);
    keepOpen(screen, timers, 20 * 60_000);
    await editor.alarm(timers.now());
    expect(box.stops).toBe(3);
    expect(screen.closed?.code).toBe(1001);
  });

  it("alarm の中で止めるのに落ちたら 1 分後に掛け直す", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers, alarms } = editorWith(box);
    await connect(editor, T0);
    box.stop = () => Promise.reject(new Error("止められない"));
    timers.advance(EDITOR_LIMITS.wakeMs);
    await editor.alarm(timers.now());
    expect(alarms.at(-1)).toBe(timers.now() + EDITOR_LIMITS.retryMs);
  });

  it("5 分の確かめで、訳が editor で期限を過ぎていれば止める (alarm が無くても)", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers } = editorWith(box);
    const screen = await connect(editor, T0);
    keepOpen(screen, timers, EDITOR_LIMITS.wakeMs - 1);
    await editor.sweep(timers.now());
    expect(box.stops).toBe(0);
    timers.advance(1);
    await editor.sweep(timers.now());
    expect(box.stops).toBe(1);
  });

  it("止める直前に出勤の start が来たら止めない (誤検知の隙)", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers } = editorWith(box);
    await connect(editor, T0);
    timers.advance(EDITOR_LIMITS.wakeMs);
    await editor.markShift();
    await editor.alarm(timers.now());
    await editor.sweep(timers.now());
    expect([box.stops, box.running]).toEqual([0, true]);
  });

  it("止める直前に新しい補完の接続が来たら止めない", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor, timers } = editorWith(box);
    await connect(editor, T0);
    editor.close({ except: null });
    timers.advance(EDITOR_LIMITS.idleMs - 1);
    // alarm の直前に支度だけ済ませた接続が来る
    await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: timers.now() });
    timers.advance(1);
    await editor.alarm(timers.now());
    expect(box.stops).toBe(0);
  });

  it("勤務の間に起きていたワークスペースは、補完の接続が切れても止めない", async () => {
    const box = fakeBox(true);
    box.trees.set(NODE, SHA);
    const { editor, timers } = editorWith(box);
    await connect(editor, T0, false);
    editor.close({ except: null });
    timers.advance(EDITOR_LIMITS.wakeMs * 3);
    await editor.alarm(timers.now());
    await editor.sweep(timers.now());
    expect(box.stops).toBe(0);
  });

  it("止める最中に来た補完の接続は止め終わるまで待ち、勤務の外で EDITOR_WAKE が off なら 503、on なら起こし直してつなぐ", async () => {
    for (const wake of [false, true]) {
      const box = fakeBox();
      box.trees.set(NODE, SHA);
      const { editor, timers } = editorWith(box);
      await connect(editor, T0);
      const gate = deferred();
      box.stopGate = gate.promise;
      timers.advance(EDITOR_LIMITS.wakeMs);
      const stopping = editor.alarm(timers.now());
      const opening = editor.prepare({ nodeId: NODE, sha: SHA, wake, now: timers.now() }).then(
        (p) => `woke=${String(p.woke)}`,
        (e: unknown) => String((e as { code?: string }).code),
      );
      gate.resolve();
      await stopping;
      expect(await opening).toBe(wake ? "woke=true" : "unavailable");
      expect(box.running).toBe(wake);
    }
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
});
