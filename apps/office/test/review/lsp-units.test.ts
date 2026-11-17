// エディタの補完の木の渡し方と、補完で起こしたワークスペースの止め方を、DO の中身の物で確かめる。ルートは lsp.test.ts、中継は lsp-relay.test.ts (タスクとレビューの 3.6、社員が考えるの 3.2)
import { describe, expect, it } from "vitest";
import { EDITOR_LIMITS, EditorLsp } from "../../src/gate/work/editor-lsp.ts";
import type { LspRelay } from "../../src/gate/work/lsp-relay.ts";
import { deferred, type FakeBox, fakeBox, type FakeSocket, fakeSocket, ManualTimers, memory } from "../helpers/lsp.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const SHA = "c".repeat(40);
const OLD = "d".repeat(40);
/** 日本時間の 2026-11-17 の 20 時。勤務の外 */
const T0 = Date.UTC(2026, 10, 17, 11);

/**
 * 投げられた物の code を読む。RPC を越えた誤りと同じく code だけを見る
 * @param error 投げられた物
 * @returns code。無ければ空
 */
function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

/**
 * 補完の中身を作る
 * @param box ワークスペースの代わり
 * @returns 中身、時計、掛けた alarm
 */
function editorWith(box: FakeBox): { editor: EditorLsp; timers: ManualTimers; alarms: number[]; ended: string[] } {
  const timers = new ManualTimers(T0);
  const alarms: number[] = [];
  const ended: string[] = [];
  const editor = new EditorLsp({ box, storage: memory(), timers, setAlarm: (at) => Promise.resolve(void alarms.push(at)), onRelayEnd: (meta) => void ended.push(meta.sessionId) });
  return { editor, timers, alarms, ended };
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
        return codeOf(error);
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
        (e: unknown) => codeOf(e),
      );
      gate.resolve();
      await stopping;
      expect(await opening).toBe(wake ? "woke=true" : "unavailable");
      expect(box.running).toBe(wake);
    }
  });
});
