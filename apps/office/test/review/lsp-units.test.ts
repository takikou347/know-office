// エディタの補完の木の渡し方と接続の閉じ方を、DO の中身の物で確かめる。起こし方と止め方は lsp-wake.test.ts、ルートは lsp.test.ts、中継は lsp-relay.test.ts (タスクとレビューの 3.2)
import { describe, expect, it } from "vitest";
import { EDITOR_LIMITS, type LspPrepared } from "../../src/gate/work/editor-lsp.ts";
import { fakeBox, fakeSocket } from "../helpers/lsp.ts";
import { codeOf, connect, editorWith, flush, NODE, OLD, SHA, T0 } from "../helpers/lsp-editor.ts";

describe("読みやすさと補完", () => {
  it("同じ session で 2 本を同時に開くと、木を渡すのは 1 度で、新しい接続を受けてから前の接続を 1008 で閉じる", async () => {
    const box = fakeBox(true);
    box.trees.set(NODE, OLD);
    const { editor } = editorWith(box);
    const pa = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    const pb = editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    // 1 本目だけが木を取りに行き、2 本目は 1 本目が渡し終えるのを待つ
    const a = await pa;
    expect(a.tree).toBe("needed");
    await editor.putTree(NODE, SHA, a.claim ?? "", new Response("木").body ?? new ReadableStream());
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
    const a = await pa;
    expect(a.tree).toBe("needed");
    await editor.dropTree(NODE, SHA, a.claim ?? "");
    expect((await pb).tree).toBe("needed");
  });

  it("木を取る役が 90 秒たっても渡し終えなければ、待っていた接続が自分で取りに行く", async () => {
    const box = fakeBox(true);
    box.trees.set(NODE, OLD);
    const { editor, timers } = editorWith(box);
    // 役を取った接続は、渡す前に Worker ごと消えた
    const lost = await editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 });
    expect(lost.tree).toBe("needed");
    const waited: { value: LspPrepared | null } = { value: null };
    void editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 }).then((p) => (waited.value = p));
    await flush();
    timers.advance(90_000 - 1);
    await flush();
    expect(waited.value).toBeNull();
    timers.advance(1);
    await flush();
    const taken = waited.value;
    expect(taken?.tree).toBe("needed");
    // 消えた役が後から渡し終えても、新しい役の約束は解かない
    const third: { value: string | null } = { value: null };
    void editor.prepare({ nodeId: NODE, sha: SHA, wake: true, now: T0 }).then((p) => (third.value = p.tree));
    await flush();
    await editor.dropTree(NODE, SHA, lost.claim ?? "");
    await flush();
    expect(third.value).toBeNull();
    await editor.putTree(NODE, SHA, taken?.claim ?? "", new Response("木").body ?? new ReadableStream());
    await flush();
    expect(third.value).toBe("ready");
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
        if (p.claim !== null) await editor.putTree(NODE, sha, p.claim, new Response("木").body ?? new ReadableStream());
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
