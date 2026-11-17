// エディタの補完の中継が、画面と木の道を行き来させ、木の外の道と型の束に無い依存の知らせを画面に出さない事を確かめる (仕事とレビューの 3.6)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTHER_TREE, record, type Relay, relay, TREE, TYPES } from "./helpers/relay.ts";

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe("補完の道", () => {
  let r: Relay;

  beforeEach(() => {
    r = relay();
  });

  afterEach(() => {
    r.session.end();
    vi.useRealTimers();
  });

  /**
   * 定義を求める
   * @param id 求めの id
   */
  async function definition(id: number): Promise<void> {
    await r.screen({ jsonrpc: "2.0", id, method: "textDocument/definition", params: { textDocument: { uri: "file:///repo/src/a.ts" }, position: { line: 0, character: 0 } } });
  }

  it("木の外を指す道は送らず、返事の道を file:///repo/ に戻し、診断の文からワークスペースの道を消す", async () => {
    // 画面からの道は file:///repo/ の下だけを木の道に直す
    await r.screen({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { textDocument: { uri: "file:///repo/src/a.ts" }, position: { line: 0, character: 0 } } });
    expect(r.tsc.received[0]).toMatchObject({ params: { textDocument: { uri: `file://${TREE}/src/a.ts` } } });
    const outside = ["file:///repo/../work/a.ts", "file:///repo/%2E%2E/work/a.ts", "file:///work/a.ts", `file://${TREE}/src/a.ts`, "file://host/repo/a.ts", "http://x/repo/a.ts", "file:///repo"];
    for (const uri of outside) {
      await r.screen({ jsonrpc: "2.0", id: uri, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 0, character: 0 } } });
      await r.screen({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: "" } } });
    }
    expect(r.tsc.received).toHaveLength(1);
    expect(r.sent).toEqual(outside.map((id) => ({ jsonrpc: "2.0", id, error: { code: -32602, message: "木の外を指す道" } })));
    r.sent.length = 0;
    // 返事の道: 木の中は file:///repo/、型の束は file:///repo/node_modules/、ほかは捨てる
    await definition(2);
    await r.fromTsc({
      jsonrpc: "2.0",
      id: 2,
      result: [
        { uri: `file://${TREE}/src/b.ts`, range: RANGE },
        { uri: `file://${TYPES}/.pnpm/knowidea-ui%400.12.1/node_modules/knowidea-ui/dist/Button.d.ts`, range: RANGE },
        { uri: "file:///work/secret.ts", range: RANGE },
        { uri: `file://${OTHER_TREE}/x.ts`, range: RANGE },
      ],
    });
    expect(r.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: [
          { uri: "file:///repo/src/b.ts", range: RANGE },
          { uri: "file:///repo/node_modules/knowidea-ui/dist/Button.d.ts", range: RANGE },
        ],
      },
    ]);
    // 1 つの道の返事が木の外なら null
    await definition(3);
    await r.fromTsc({ jsonrpc: "2.0", id: 3, result: { uri: "file:///etc/passwd", range: RANGE } });
    expect(r.sent[1]).toEqual({ jsonrpc: "2.0", id: 3, result: null });
    r.sent.length = 0;
    // 木の外の診断の知らせは捨て、関わりの道が木の外の物は外し、文からワークスペースの道と木の外の道を消す
    await r.fromTsc({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///work/x.ts", diagnostics: [] } });
    await r.fromTsc({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: `file://${TREE}/tsconfig.json`,
        diagnostics: [
          {
            range: RANGE,
            code: 5083,
            message: `Cannot read file '${TREE}/base.json' or '${OTHER_TREE}/x.json' or '${TYPES}/.pnpm/react@19.3.1/node_modules/react/index.d.ts' or '/work/secret/tsconfig.json'.`,
            relatedInformation: [
              { location: { uri: "file:///work/x.ts", range: RANGE }, message: "外" },
              { location: { uri: `file://${TREE}/src/a.ts`, range: RANGE }, message: `中 ${TREE}/src/a.ts` },
            ],
          },
        ],
      },
    });
    expect(r.sent).toEqual([
      {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: "file:///repo/tsconfig.json",
          diagnostics: [
            {
              range: RANGE,
              code: 5083,
              message: "Cannot read file '/repo/base.json' or '/repo/x.json' or '/repo/node_modules/react/index.d.ts' or '<木の外>'.",
              relatedInformation: [{ location: { uri: "file:///repo/src/a.ts", range: RANGE }, message: "中 /repo/src/a.ts" }],
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(r.sent)).not.toMatch(/\/review|\/opt\/workspace|\/work/);
  });

  it("型の束に無いモジュールが見つからない知らせは出さない", async () => {
    const diagnostics = [
      { range: RANGE, code: 2307, message: "Cannot find module 'missing-pkg' or its corresponding type declarations." },
      { range: RANGE, code: 2307, message: "Cannot find module '@scope/pkg/sub' or its corresponding type declarations." },
      { range: RANGE, code: 7016, message: "Could not find a declaration file for module 'untyped'." },
      { range: RANGE, code: 2792, message: "Cannot find module 'other'. Did you mean to set the 'moduleResolution' option to 'nodenext'?" },
      // 木の中の道の書き間違いと型の誤りは出す
      { range: RANGE, code: 2307, message: "Cannot find module './missing' or its corresponding type declarations." },
      { range: RANGE, code: 2322, message: "Type 'string' is not assignable to type 'number'." },
    ];
    await r.fromTsc({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: `file://${TREE}/src/a.ts`, diagnostics } });
    // 求めて取る診断も同じ
    await r.screen({ jsonrpc: "2.0", id: 1, method: "textDocument/diagnostic", params: { textDocument: { uri: "file:///repo/src/a.ts" } } });
    await r.fromTsc({ jsonrpc: "2.0", id: 1, result: { kind: "full", items: diagnostics } });
    expect(r.sent.map((message) => record(message.params ?? message.result))).toEqual([
      { uri: "file:///repo/src/a.ts", diagnostics: [diagnostics[4], diagnostics[5]] },
      { kind: "full", items: [diagnostics[4], diagnostics[5]] },
    ]);
  });
});
