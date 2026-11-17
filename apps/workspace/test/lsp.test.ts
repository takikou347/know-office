// エディタの補完の中継が、画面の JSON-RPC を絞り、tsc の要求に自分で答え、止める時に tsc を止める事を確かめる (仕事とレビューの 3.6、社員が考えるの 2 章)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LSP_IDLE_MS, LspSession, RSS_CHECK_MS } from "../src/lsp.ts";
import { TSC_RSS_LIMIT_BYTES } from "../src/lsp-tsc.ts";
import { fakeTsc, flush } from "./helpers/fake-tsc.ts";
import { list, record, type Relay, relay, REVIEW, TREE, TYPES } from "./helpers/relay.ts";

describe("補完の中継", () => {
  let r: Relay;

  beforeEach(() => {
    r = relay();
  });

  afterEach(() => {
    r.session.end();
    vi.useRealTimers();
  });

  it("初期化の rootUri、workspaceFolders、initializationOptions、capabilities を決めた値に作り直して tsc に渡す", async () => {
    await r.screen({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: 1,
        rootUri: "file:///work",
        rootPath: "/work",
        workspaceFolders: [{ uri: "file:///work", name: "w" }],
        initializationOptions: { tsserver: { path: "/work/evil" } },
        capabilities: { workspace: { applyEdit: true, executeCommand: {} }, textDocument: { publishDiagnostics: { relatedInformation: true } } },
      },
    });
    expect(r.tsc.received).toHaveLength(1);
    expect(r.tsc.received[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const params = record(r.tsc.received[0]?.params);
    expect(params).toEqual({
      processId: null,
      clientInfo: { name: "know-office" },
      rootUri: `file://${TREE}`,
      workspaceFolders: [{ uri: `file://${TREE}`, name: "repo" }],
      capabilities: expect.any(Object) as unknown,
    });
    // 画面が求めた物は使わず、決めた物を渡す
    expect(params.capabilities).not.toMatchObject({ workspace: { applyEdit: true } });
    expect(JSON.stringify(params)).not.toContain("/work");
    // 初期化の返事は画面に返す
    await r.fromTsc({ jsonrpc: "2.0", id: 1, result: { capabilities: { hoverProvider: true } } });
    expect(r.sent).toEqual([{ jsonrpc: "2.0", id: 1, result: { capabilities: { hoverProvider: true } } }]);
  });

  it("許した method のほかは tsc に送らずに誤りを返す", async () => {
    const denied = ["workspace/executeCommand", "textDocument/rename", "workspace/symbol", "textDocument/formatting", "$/setTrace"];
    for (const method of denied) {
      await r.screen({ jsonrpc: "2.0", id: method, method, params: {} });
    }
    // 知らせ (id の無い物) は黙って捨てる
    await r.screen({ jsonrpc: "2.0", method: "workspace/didChangeWatchedFiles", params: { changes: [] } });
    // JSON でない物、並びの物は形の誤りを返す
    await r.screen("not json");
    await r.screen([{ jsonrpc: "2.0", id: 9, method: "textDocument/hover", params: {} }]);
    expect(r.tsc.received).toEqual([]);
    expect(r.sent).toEqual([
      ...denied.map((id) => ({ jsonrpc: "2.0", id, error: { code: -32601, message: "許していない method" } })),
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON として読めない" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC の 1 件でない" } },
    ]);
    // 許した物は通す
    const allowed = ["textDocument/hover", "textDocument/completion", "textDocument/definition", "textDocument/diagnostic"];
    for (const method of allowed) {
      await r.screen({ jsonrpc: "2.0", id: method, method, params: { textDocument: { uri: "file:///repo/src/a.ts" }, position: { line: 0, character: 0 } } });
    }
    expect(r.tsc.received.map((message) => message.method)).toEqual(allowed);
  });

  it("tsc から画面への要求 (workspace/configuration、client/registerCapability) はワークスペースが答え、画面に渡さない", async () => {
    await r.fromTsc({ jsonrpc: "2.0", id: "ts1", method: "workspace/configuration", params: { items: [{ section: "typescript" }, { section: "editor" }] } });
    await r.fromTsc({ jsonrpc: "2.0", id: "ts2", method: "client/registerCapability", params: { registrations: [] } });
    await r.fromTsc({ jsonrpc: "2.0", id: "ts3", method: "workspace/applyEdit", params: { edit: {} } });
    // 診断のほかの知らせも画面に渡さない
    await r.fromTsc({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: `${TREE}/src/a.ts` } });
    expect(r.sent).toEqual([]);
    expect(r.tsc.received).toEqual([
      { jsonrpc: "2.0", id: "ts1", result: [null, null] },
      { jsonrpc: "2.0", id: "ts2", result: null },
      { jsonrpc: "2.0", id: "ts3", result: null },
    ]);
  });

  it("画面から来た、tsc の要求への返事の形の物は tsc に通さない", async () => {
    await r.fromTsc({ jsonrpc: "2.0", id: "ts1", method: "workspace/configuration", params: { items: [{ section: "typescript" }] } });
    const answered = r.tsc.received.length;
    await r.screen({ jsonrpc: "2.0", id: "ts1", result: [{ tsserver: { path: "/work/evil" } }] });
    await r.screen({ jsonrpc: "2.0", id: "ts2", error: { code: 1, message: "x" } });
    expect(r.tsc.received).toHaveLength(answered);
    // tsc から画面の求めていない返事も画面に渡さない
    await r.fromTsc({ jsonrpc: "2.0", id: 77, result: { contents: "x" } });
    expect(r.sent).toEqual([]);
  });

  it("候補の中の道は画面に出さず、詳しい中身を求める時に元に戻す", async () => {
    await r.screen({ jsonrpc: "2.0", id: 1, method: "textDocument/completion", params: { textDocument: { uri: "file:///repo/src/a.tsx" }, position: { line: 0, character: 0 } } });
    const data = { fileName: `${TREE}/src/a.tsx`, position: 116, name: "variant" };
    await r.fromTsc({ jsonrpc: "2.0", id: 1, result: { isIncomplete: false, items: [{ label: "variant?", data }] } });
    const item = list(record(r.sent[0]?.result).items)[0];
    expect(JSON.stringify(item)).not.toContain(TREE);
    await r.screen({ jsonrpc: "2.0", id: 2, method: "completionItem/resolve", params: item });
    expect(r.tsc.received[1]).toEqual({ jsonrpc: "2.0", id: 2, method: "completionItem/resolve", params: { label: "variant?", data } });
    await r.fromTsc({ jsonrpc: "2.0", id: 2, result: { label: "variant?", detail: "x", data } });
    expect(JSON.stringify(r.sent[1])).not.toContain(TREE);
    // 画面が作った中身は通さない
    await r.screen({ jsonrpc: "2.0", id: 3, method: "completionItem/resolve", params: { label: "x", data: { fileName: "/work/a.ts", position: 0, name: "x" } } });
    expect(r.tsc.received).toHaveLength(2);
    expect(r.sent.at(-1)).toMatchObject({ id: 3, error: { code: -32602 } });
  });

  it("tsc の RSS が 384MiB を超えたら kill して接続を 1011 で閉じる", async () => {
    expect({ limit: TSC_RSS_LIMIT_BYTES, every: RSS_CHECK_MS }).toEqual({ limit: 384 * 1024 * 1024, every: 10_000 });
    // ちょうどは止めない
    r.setRss(TSC_RSS_LIMIT_BYTES);
    await vi.advanceTimersByTimeAsync(RSS_CHECK_MS);
    expect({ signals: r.tsc.signals, closed: r.closed }).toEqual({ signals: [], closed: [] });
    r.setRss(TSC_RSS_LIMIT_BYTES + 1);
    await vi.advanceTimersByTimeAsync(RSS_CHECK_MS - 1);
    expect(r.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.tsc.signals).toEqual(["SIGKILL"]);
    expect(r.closed).toEqual([{ code: 1011, reason: "tsc のメモリが上限を超えた" }]);
    expect(r.ended()).toBe(1);
    // 閉じた後は読まない
    r.setRss(null);
    await vi.advanceTimersByTimeAsync(RSS_CHECK_MS * 3);
    expect(r.closed).toHaveLength(1);
  });

  it("接続が切れたら tsc を止め、10 分使わなければ止める", async () => {
    expect(LSP_IDLE_MS).toBe(600_000);
    // 送りがあれば待ちを始め直す
    await vi.advanceTimersByTimeAsync(LSP_IDLE_MS - 1);
    await r.screen({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///repo/src/a.ts", version: 2 }, contentChanges: [{ text: "" }] } });
    await vi.advanceTimersByTimeAsync(LSP_IDLE_MS - 1);
    expect(r.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.closed).toEqual([{ code: 1000, reason: "使われていない" }]);
    expect(r.tsc.signals).toEqual(["SIGKILL"]);
    expect(r.ended()).toBe(1);
    // 接続が切れた時も止める。2 回目は何もしない
    const other = fakeTsc(4343);
    const second = new LspSession({ tree: TREE, reviewRoot: REVIEW, typesRoots: [TYPES], tsc: other.proc, send: () => {}, close: () => {}, readRss: () => 0 });
    second.end();
    second.end();
    expect(other.signals).toEqual(["SIGKILL"]);
  });

  it("tsc が落ちたら接続を 1011 で閉じる", async () => {
    r.tsc.proc.emit("exit", 1, null);
    await flush();
    expect(r.closed).toEqual([{ code: 1011, reason: "tsc が止まった" }]);
    expect(r.ended()).toBe(1);
  });
});
