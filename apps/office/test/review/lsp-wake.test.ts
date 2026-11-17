// 補完で起こしたワークスペースの起こし方と止め方を、DO の中身の物で確かめる (タスクとレビューの 3.6、社員が考えるの 3.2)
import { describe, expect, it } from "vitest";
import { EDITOR_LIMITS } from "../../src/gate/work/editor-lsp.ts";
import { deferred, fakeBox } from "../helpers/lsp.ts";
import { codeOf, connect, editorWith, flush, gatedStorage, keepOpen, NODE, SHA, T0 } from "../helpers/lsp-editor.ts";

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

  it("出勤の start が訳を勤務に書いている間に来た補完の接続は、訳を補完に書き換えずに 503", async () => {
    const box = fakeBox();
    const storage = gatedStorage();
    const { editor, timers, alarms } = editorWith(box, storage);
    const gate = deferred();
    storage.gate = gate.promise;
    const shift = editor.markShift();
    await flush();
    const opening = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 }).then(
      (p) => `woke=${String(p.woke)}`,
      (e: unknown) => codeOf(e),
    );
    await flush();
    storage.gate = null;
    gate.resolve();
    await shift;
    expect(await opening).toBe("unavailable");
    expect(box.wakes).toBe(0);
    expect((await storage.read()).by).toBe("shift");
    // 勤務の物は補完の期限で止めない
    box.isRunning = true;
    timers.advance(EDITOR_LIMITS.wakeMs * 2);
    await editor.alarm(timers.now());
    expect([box.stops, alarms]).toEqual([0, []]);
  });

  it("補完で起こしたワークスペースが落ちてから起こし直すと、落ちるまでの長さも 1 日の予算から減る", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const storage = gatedStorage();
    const { editor, timers } = editorWith(box, storage);
    await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    // 止める判断を通らずにコンテナが落ちた
    timers.advance(40 * 60_000);
    box.isRunning = false;
    expect((await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: timers.now() })).woke).toBe(true);
    expect(await storage.read()).toEqual({ by: "editor", wokeAt: timers.now(), usedMs: 40 * 60_000 });
    // 起こすのに落ちた時も、起こそうとした間を数える
    timers.advance(10 * 60_000);
    box.isRunning = false;
    box.wakeOnce = async () => {
      timers.advance(5 * 60_000);
      return Promise.reject(Object.assign(new Error("起きない"), { code: "unavailable" }));
    };
    await expect(editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: timers.now() })).rejects.toMatchObject({ code: "unavailable" });
    expect(await storage.read()).toEqual({ by: null, wokeAt: null, usedMs: (40 + 10 + 5) * 60_000 });
  });

  it("同じ時に来た 2 本の補完の接続は、ワークスペースを 1 回だけ起こす", async () => {
    const box = fakeBox();
    box.trees.set(NODE, SHA);
    const { editor } = editorWith(box);
    const results = await Promise.all([editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 }), editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 })]);
    expect(box.wakes).toBe(1);
    expect(results.map((r) => r.woke).toSorted((x, y) => Number(x) - Number(y))).toEqual([false, true]);
    // 起きなかった時は、待っていた方も起こし直さずに 503
    const failing = fakeBox();
    failing.wakeFails = true;
    const other = editorWith(failing).editor;
    const both = await Promise.all([0, 1].map(() => other.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 }).then(() => "通った", codeOf)));
    expect([both, failing.wakes]).toEqual([["unavailable", "unavailable"], 1]);
  });
});
