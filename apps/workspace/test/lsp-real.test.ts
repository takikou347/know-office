// 本物の tsc --lsp をワークスペースのサーバーの補完の口から使い、候補と型の誤りが返り、木の外を返さない事を確かめる (仕事とレビューの 3.6)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Client, lspServer, notify, request } from "./helpers/lsp-server.ts";
import { list, NODE, record, SHA } from "./helpers/relay.ts";
import { type TarEntry, tarGz } from "./helpers/tar.ts";

describe("本物の tsc", () => {
  const s = lspServer();

  beforeAll(() => s.start());
  afterAll(() => s.stop());
  beforeEach(() => {
    s.reset();
    s.useRealTsc(true);
  });
  afterEach(() => s.clean());

  /**
   * 木を渡してつなぎ、初期化してファイルを開く
   * @param files 木
   * @param path 開くファイルの木の中の道
   * @returns 接続
   */
  async function open(files: TarEntry[], path: string): Promise<Client> {
    expect((await s.put(`/v1/lsp/trees/${NODE}/${SHA}`, tarGz(files))).status).toBe(204);
    const client = await s.connect(`?nodeId=${NODE}&sha=${SHA}`);
    if (typeof client === "number") throw new Error(`開けない ${client}`);
    expect(await request(client, 1, "initialize", { processId: 1, rootUri: "file:///work", capabilities: {} })).toHaveProperty("result.capabilities");
    notify(client, "initialized", {});
    const text = files.find((file) => file.name === `top/${path}`)?.body ?? "";
    notify(client, "textDocument/didOpen", { textDocument: { uri: `file:///repo/${path}`, languageId: path.endsWith("x") ? "typescriptreact" : "typescript", version: 1, text } });
    return client;
  }

  it("本物の tsc --lsp で候補と型の誤りが返る", async () => {
    const files: TarEntry[] = [
      { name: "top/", type: "dir" },
      { name: "top/tsconfig.json", body: JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true }, include: ["src"] }) },
      { name: "top/src/a.tsx", body: 'import { Button } from "knowidea-ui";\nimport x from "missing-pkg";\nconst n: number = "a";\nexport const el = <Button />;\nexport { x, n };\n' },
    ];
    const client = await open(files, "src/a.tsx");
    const uri = "file:///repo/src/a.tsx";
    // <Button の後ろで引数の候補を求める
    const completion = await request(client, 2, "textDocument/completion", { textDocument: { uri }, position: { line: 3, character: 26 } });
    expect(list(record(completion.result).items).map((item) => record(item).label)).toContain("variant?");
    const diagnostic = await request(client, 3, "textDocument/diagnostic", { textDocument: { uri } });
    const codes = list(record(diagnostic.result).items).map((item) => record(item).code);
    expect(codes).toContain(2322);
    // 型の束に無い missing-pkg は出さない
    expect(codes).not.toContain(2307);
    const definition = await request(client, 4, "textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 10 } });
    expect(definition.result).toEqual([expect.objectContaining({ uri: "file:///repo/node_modules/knowidea-ui/dist/Button.d.ts" })]);
    expect(JSON.stringify(client.received)).not.toContain(s.base());
    client.socket.close();
    await client.closed;
  });

  it("tsconfig の extends、include、typeRoots、references が木の外を指しても、木の外の中身を返さない", async () => {
    // 木の外に置いた物。コンテナでは lsp の利用者が読めない /work に当たる。読めない事はイメージのテストで確かめる
    const outside = join(s.base(), "outside");
    mkdirSync(join(outside, "types", "leak"), { recursive: true });
    writeFileSync(join(outside, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    writeFileSync(join(outside, "secret.ts"), 'export const secretValue: number = "outside-secret";\n');
    writeFileSync(join(outside, "types", "leak", "index.d.ts"), "declare const leaked: number;\n");
    const files: TarEntry[] = [
      { name: "top/", type: "dir" },
      {
        name: "top/tsconfig.json",
        body: JSON.stringify({ extends: join(outside, "tsconfig.json"), compilerOptions: { typeRoots: [join(outside, "types")], noEmit: true }, include: ["src", join(outside, "*.ts")], references: [{ path: outside }] }),
      },
      { name: "top/src/a.ts", body: "export const a: string = leaked;\n" },
    ];
    const client = await open(files, "src/a.ts");
    const uri = "file:///repo/src/a.ts";
    await request(client, 2, "textDocument/diagnostic", { textDocument: { uri } });
    // 木の外の定義は返さない
    expect((await request(client, 3, "textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 27 } })).result).toEqual([]);
    // 画面からは木の外を開けない
    const hover = await request(client, 4, "textDocument/hover", { textDocument: { uri: `file:///repo/..${outside}/secret.ts` }, position: { line: 0, character: 14 } });
    expect(hover).toMatchObject({ error: { code: -32602 } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(JSON.stringify(client.received)).not.toContain(outside);
    expect(JSON.stringify(client.received)).not.toContain("outside-secret");
    client.socket.close();
    await client.closed;
  });
});
