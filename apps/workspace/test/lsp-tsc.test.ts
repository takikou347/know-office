// 補完の tsc を利用者 lsp、nice 10、GOMEMLIMIT で起こし、型の束の版が画面と同じ事を確かめる (社員が考えるの 2 章、3.2)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LSP_GID, LSP_UID, TSC_MEMORY_LIMIT, tscSpawner } from "../src/lsp-tsc.ts";
import { record } from "./helpers/relay.ts";

const TREE = `/review/0190f4a8-0000-7000-8000-000000000101/${"a".repeat(40)}`;

/**
 * package.json を読む
 * @param path このファイルからの道
 * @returns dependencies と devDependencies
 */
function packageJson(path: string): { dependencies: Record<string, unknown>; devDependencies: Record<string, unknown> } {
  const json = record(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")));
  return { dependencies: record(json.dependencies ?? {}), devDependencies: record(json.devDependencies ?? {}) };
}

describe("tsc の起こし方", () => {
  it("tsc は lsp の利用者で、nice 10 と GOMEMLIMIT を付けて起こす", () => {
    expect({ uid: LSP_UID, gid: LSP_GID, memory: TSC_MEMORY_LIMIT }).toEqual({ uid: 10002, gid: 10002, memory: "256MiB" });
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
    const spawn = (command: string, args: string[], options: Record<string, unknown>): unknown => {
      calls.push({ command, args, options });
      return {};
    };
    tscSpawner({ spawn, uid: () => 0 })(TREE);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe("/usr/bin/nice");
    expect(call?.args.slice(0, 3)).toEqual(["-n", "10", process.execPath]);
    expect(call?.args.at(-3)).toMatch(/typescript\/bin\/tsc$/);
    expect(call?.args.slice(-2)).toEqual(["--lsp", "--stdio"]);
    expect(call?.options).toMatchObject({ cwd: TREE, uid: LSP_UID, gid: LSP_GID, stdio: ["pipe", "pipe", "ignore"] });
    // 環境変数はサーバーの物を受け継がず、要る物だけにする
    expect(call?.options.env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", GOMEMLIMIT: TSC_MEMORY_LIMIT });
    // root でなければ利用者を落とせないので起こさない
    expect(() => tscSpawner({ spawn, uid: () => 1000 })(TREE)).toThrow(/root/);
    // 手元の代わりのワークスペースは利用者を落とさない
    tscSpawner({ spawn, uid: () => 1000 }, { asLsp: false })(TREE);
    expect(calls[1]?.options).not.toHaveProperty("uid");
  });
});

describe("型の束", () => {
  it("型の束の版は apps/office の依存と同じ", () => {
    const office = packageJson("../../office/package.json");
    const workspace = packageJson("../package.json");
    const officeDeps = { ...office.devDependencies, ...office.dependencies };
    const bundle = ["react", "@types/react", "hono", "knowidea-ui", "knowidea-css", "knowidea-tokens", "knowidea-icons"];
    expect(Object.fromEntries(bundle.map((name) => [name, workspace.dependencies[name]]))).toEqual(Object.fromEntries(bundle.map((name) => [name, officeDeps[name]])));
    // イメージは --prod で入れるので、型の束と tsc と ws は dependencies に置く
    expect(Object.keys(workspace.dependencies)).toEqual(expect.arrayContaining([...bundle, "typescript", "ws"]));
  });
});
