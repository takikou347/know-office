// レビューのエディタの補完の口。書き換えるまではつながず、初めて書き換えた時に作業トークンで開き、tsc の JSON-RPC をエディタの候補と下線と説明に直す (タスクとレビューの 3.2)
import { describe, expect, it } from "vitest";
import { type LspDeps, type LspSocket, reviewLsp } from "../../src/screen/pages/staff/review-lsp.ts";

/** 画面が送った JSON-RPC */
type Sent = { id?: number; method: string; params?: Record<string, unknown> };

/**
 * 待っている処理を進める
 * @returns 進んだ時
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 手で答える補完の口。answer が返した物を result として返し、undefined なら答えない
 * @param answer 求めに答える関数
 * @param options 作業トークンを出せるか、開いたらすぐ閉じるか
 * @param options.ticket 出す作業トークン。null は出せない
 * @param options.refuse 開いたらつながずに閉じる
 * @returns 口、送られた物、開いた作業トークン、ソケットを閉じる関数
 */
function fakeLsp(answer: (sent: Sent) => unknown, options: { ticket?: string | null; refuse?: boolean } = {}) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  const sockets: { emit: (type: "open" | "close" | "message", data?: unknown) => void; closed: boolean }[] = [];
  const deps: LspDeps = {
    ticket: () => Promise.resolve(options.ticket === undefined ? "t1" : options.ticket),
    open: (ticket) => {
      opened.push(ticket);
      const handlers: { type: string; listener: (e: { data?: unknown }) => void }[] = [];
      const own = {
        closed: false,
        emit: (type: "open" | "close" | "message", data?: unknown) => {
          for (const h of handlers) if (h.type === type) h.listener({ data });
        },
      };
      const socket: LspSocket = {
        addEventListener: (type, listener) => handlers.push({ type, listener }),
        send: (data) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const message = JSON.parse(data) as Sent;
          sent.push(message);
          if (message.id === undefined) return;
          const result = answer(message);
          if (result !== undefined) setTimeout(() => own.emit("message", JSON.stringify({ jsonrpc: "2.0", id: message.id, result })), 0);
        },
        close: () => {
          own.closed = true;
          own.emit("close");
        },
      };
      sockets.push(own);
      setTimeout(() => own.emit(options.refuse ? "close" : "open"), 0);
      return socket;
    },
  };
  return { deps, sent, opened, sockets };
}

const PATH = "src/Card.tsx";
const URI = "file:///repo/src/Card.tsx";

/**
 * tsc の代わりの答え
 * @param sent 求め
 * @returns 結果
 */
function tsc(sent: Sent): unknown {
  if (sent.method === "initialize") return { capabilities: {} };
  if (sent.method === "textDocument/completion") {
    return { isIncomplete: false, items: [{ label: "variant?", kind: 10, detail: '"primary" | "ghost"', insertText: "variant" }, { label: "Button", kind: 7 }, { label: "fn", kind: 3, insertText: "fn($1)", insertTextFormat: 2 }] };
  }
  if (sent.method === "textDocument/diagnostic") {
    return { kind: "full", items: [{ range: { start: { line: 3, character: 13 }, end: { line: 3, character: 18 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", code: 2322 }, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "w" }] };
  }
  if (sent.method === "textDocument/hover") return { contents: { kind: "markdown", value: "```typescript\nconst card: JSX.Element\n```\nカード" } };
  return null;
}

describe("レビューのエディタの補完の口", () => {
  it("書き換えるまではつながず、初めて診断を求めた時に作業トークンで開き、初期化してからファイルを開く", async () => {
    const f = fakeLsp(tsc);
    const lsp = reviewLsp(f.deps, PATH);
    // 型と説明だけでは開かない (読むだけの時に合わせただけでつながない)
    expect(await lsp.hover({ line: 1, column: 1, text: "a" })).toBeNull();
    expect(f.opened).toEqual([]);
    await lsp.diagnose("a\n");
    expect(f.opened).toEqual(["t1"]);
    expect(f.sent.map((s) => s.method)).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/diagnostic"]);
    expect(f.sent[2]?.params).toEqual({ textDocument: { uri: URI, languageId: "typescriptreact", version: 1, text: "a\n" } });
    // 2 回目は同じ接続で、変えた中身を全部送ってから求める
    await lsp.diagnose("ab\n");
    expect(f.opened).toHaveLength(1);
    expect(f.sent.slice(4).map((s) => s.method)).toEqual(["textDocument/didChange", "textDocument/diagnostic"]);
    expect(f.sent[4]?.params).toEqual({ textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "ab\n" }] });
    lsp.close();
    await tick();
    expect(f.sockets[0]?.closed).toBe(true);
  });

  it("候補を 0 から数える位置で求め、エディタの候補の形に直す", async () => {
    const f = fakeLsp(tsc);
    const lsp = reviewLsp(f.deps, PATH);
    const items = await lsp.complete({ line: 3, column: 10, text: "x\ny\nz\n<Button " });
    expect(f.sent.find((s) => s.method === "textDocument/completion")?.params).toEqual({ textDocument: { uri: URI }, position: { line: 2, character: 9 } });
    // 省ける引数の印 (?) は入れる文字に付けず、雛形 (snippet) の印は入れない
    expect(items).toEqual([
      { label: "variant?", detail: '"primary" | "ghost"', type: "property", apply: "variant" },
      { label: "Button", type: "class", apply: "Button" },
      { label: "fn", type: "function", apply: "fn" },
    ]);
  });

  it("診断を 1 から数える行と列の下線に直し、書き換えの間に古くなった診断は捨てる", async () => {
    const held: { release: ((v: unknown) => void) | null } = { release: null };
    const f = fakeLsp((sent) => {
      if (sent.method === "textDocument/diagnostic" && held.release === null) {
        // 1 回目の診断は、次の書き換えを送るまで答えない
        const id = sent.id;
        held.release = (v) => f.sockets[0]?.emit("message", JSON.stringify({ jsonrpc: "2.0", id, result: v }));
        return undefined;
      }
      return tsc(sent);
    });
    const lsp = reviewLsp(f.deps, PATH);
    const first = lsp.diagnose("1\n");
    while (held.release === null) await tick();
    const second = lsp.diagnose("2\n");
    await tick();
    held.release(tsc({ method: "textDocument/diagnostic" }));
    expect(await first).toBeNull();
    expect(await second).toEqual([
      { line: 4, column: 14, endLine: 4, endColumn: 19, severity: "error", message: "Type 'string' is not assignable to type 'number'." },
      { line: 1, column: 1, endLine: 1, endColumn: 2, severity: "warning", message: "w" },
    ]);
  });

  it("つないだ後は型と説明を求め、印の囲みを外して返す", async () => {
    const f = fakeLsp(tsc);
    const lsp = reviewLsp(f.deps, PATH);
    await lsp.diagnose("const card = 1;\n");
    expect(await lsp.hover({ line: 1, column: 7, text: "const card = 1;\n" })).toBe("const card: JSX.Element\nカード");
    expect(f.sent.find((s) => s.method === "textDocument/hover")?.params).toEqual({ textDocument: { uri: URI }, position: { line: 0, character: 6 } });
  });

  it("つなげなければ null を返し、同じエディタではつなぎ直さない", async () => {
    const refused = fakeLsp(tsc, { refuse: true });
    const lsp = reviewLsp(refused.deps, PATH);
    expect(await lsp.diagnose("a")).toBeNull();
    expect(await lsp.complete({ line: 1, column: 1, text: "a" })).toBeNull();
    expect(refused.opened).toHaveLength(1);
    const noTicket = fakeLsp(tsc, { ticket: null });
    expect(await reviewLsp(noTicket.deps, PATH).diagnose("a")).toBeNull();
    expect(noTicket.opened).toEqual([]);
  });

  it("つないだ後に閉じられたら、次の求めで開き直してファイルを開き直す", async () => {
    const f = fakeLsp(tsc);
    const lsp = reviewLsp(f.deps, PATH);
    await lsp.diagnose("a");
    f.sockets[0]?.emit("close");
    await lsp.diagnose("b");
    expect(f.opened).toHaveLength(2);
    expect(f.sent.filter((s) => s.method === "textDocument/didOpen").map((s) => s.params?.["textDocument"])).toEqual([
      { uri: URI, languageId: "typescriptreact", version: 1, text: "a" },
      { uri: URI, languageId: "typescriptreact", version: 1, text: "b" },
    ]);
  });

  it("閉じた後に求めれば開き直す (開発の StrictMode で付け直した時)", async () => {
    const f = fakeLsp(tsc);
    const lsp = reviewLsp(f.deps, PATH);
    lsp.close();
    expect(await lsp.diagnose("a")).toEqual([expect.objectContaining({ severity: "error" }), expect.objectContaining({ severity: "warning" })]);
    expect(f.opened).toHaveLength(1);
    lsp.close();
    await tick();
    expect(f.sockets[0]?.closed).toBe(true);
    await lsp.diagnose("b");
    expect(f.opened).toHaveLength(2);
  });

  it("つないだ後に続けて閉じられたら、3 回で開き直さなくなる", async () => {
    const f = fakeLsp(tsc);
    const clock = { at: 0, now: () => clock.at };
    const lsp = reviewLsp(f.deps, PATH, clock);
    await lsp.diagnose("a");
    // 1 分に 3 回までは開き直す。1 分より前に閉じられた物は数えない
    for (const at of [10_000, 20_000, 30_000]) {
      clock.at = at;
      f.sockets.at(-1)?.emit("close");
      await lsp.diagnose(String(at));
    }
    expect(f.opened).toHaveLength(4);
    clock.at = 40_000;
    f.sockets.at(-1)?.emit("close");
    expect(await lsp.diagnose("b")).toBeNull();
    expect(f.opened).toHaveLength(4);

    const later = fakeLsp(tsc);
    const spaced = { at: 0, now: () => spaced.at };
    const slow = reviewLsp(later.deps, PATH, spaced);
    await slow.diagnose("a");
    for (const at of [10_000, 20_000, 30_000, 75_000]) {
      spaced.at = at;
      later.sockets.at(-1)?.emit("close");
      await slow.diagnose(String(at));
    }
    expect(later.opened).toHaveLength(5);
  });

  it("TypeScript と JavaScript でないファイルはつながない", async () => {
    const f = fakeLsp(tsc);
    expect(await reviewLsp(f.deps, "README.md").diagnose("# a")).toBeNull();
    expect(f.opened).toEqual([]);
  });
});
