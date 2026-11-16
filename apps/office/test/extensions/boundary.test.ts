// 拡張の境目。置き場は拡張の外を指せず、形の違う定義は差し込めない (サービスと拡張の 3.8)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineExtension, type ExtensionDefinition } from "../../src/gate/extensions/define.ts";
import { collectExtensions } from "../../src/gate/extensions/installed.ts";
import { extensionStore, toggleExtension } from "../../src/gate/extensions/state.ts";
import { api, MINUTE, rows, useWork } from "../helpers/work.ts";

const world = useWork();

/**
 * 形の合う拡張の定義を作る
 * @param over 変える項目
 * @returns 定義
 */
function definition(over: Partial<ExtensionDefinition> = {}): ExtensionDefinition {
  return { id: "test-ext", title: "試す", ownerData: false, routes: [], tools: {}, ...over };
}

describe("拡張の境目", () => {
  it("置き場のキーは、拡張の置き場の外を指す形と長すぎる形を断る", async () => {
    const store = extensionStore(world.d1.FILES, "test-ext");
    for (const key of ["../x", "a/b", "a.b", "Note", "", "-a", "a".repeat(65)]) {
      await expect(store.put(key, 1)).rejects.toThrow("拡張の置き場のキーの形が違う");
      await expect(store.get(key)).rejects.toThrow("拡張の置き場のキーの形が違う");
    }
    await store.put("a".repeat(64), 1);
    expect(await store.get("a".repeat(64))).toBe(1);
    expect((await world.d1.FILES.list({ prefix: "ext/test-ext/" })).objects.map((o) => o.key)).toEqual([`ext/test-ext/${"a".repeat(64)}.json`]);
  });

  it("形の違う ID、ツールの名前、パスは定義で断る", () => {
    const route = { method: "get", operationId: "getTest", summary: "試す", response: z.object({}).strict(), run: () => Promise.resolve({}) } as const;
    const tool = { schema: z.object({}).strict(), run: () => Promise.resolve({}) };
    for (const id of ["Test", "test_ext", "test--ext", "-test", "test-", "1test", ""]) expect(() => defineExtension(definition({ id }))).toThrow("拡張の ID の形が違う");
    for (const name of ["Read", "note__read", "note-read", "_note", "note_"]) expect(() => defineExtension(definition({ tools: { [name]: tool } }))).toThrow("ツールの名前の形が違う");
    for (const path of ["note", "/", "/../x", "/a/./b", "/Note", "/a_b", "/a/"]) expect(() => defineExtension(definition({ routes: [{ ...route, path }] }))).toThrow("ルートのパスの形が違う");
    expect(defineExtension(definition({ tools: { note_read: tool }, routes: [{ ...route, path: "/a/b-c" }] })).id).toBe("test-ext");
  });

  it("読み込みは、ID の重なり、ID とフォルダの名前の違い、defineExtension() を通していない値を断る", () => {
    const a = defineExtension(definition({ id: "a" }));
    expect(() => collectExtensions({ "../../extensions/a/index.ts": { default: a }, "../../extensions/b/index.ts": { default: a } })).toThrow("ID がフォルダの名前と違う");
    expect(() => collectExtensions({ "../../extensions/a/index.ts": { default: a }, "../../extensions/x/a/index.ts": { default: a } })).toThrow("拡張の ID が重なる");
    expect(() => collectExtensions({ "../../extensions/b/index.ts": { default: a } })).toThrow("ID がフォルダの名前と違う");
    expect(() => collectExtensions({ "../../extensions/a/index.ts": { default: definition({ id: "a" }) } })).toThrow("defineExtension() の値でない");
    expect(() => collectExtensions({ "../../extensions/a/index.ts": {} })).toThrow("defineExtension() の値でない");
    expect(collectExtensions({ "../../extensions/b/index.ts": { default: defineExtension(definition({ id: "b" })) }, "../../extensions/a/index.ts": { default: a } }).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("入れ切りは、読んだ後に版が進んでいたら conflict で断り、行を足さない", async () => {
    const now = world.clock.now();
    expect(await toggleExtension(world.d1.DB, { id: "sample-notes", enabled: true, now }, 0)).toBe(1);
    await expect(toggleExtension(world.d1.DB, { id: "sample-notes", enabled: false, now }, 0)).rejects.toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT version, value FROM settings WHERE key = 'extension.sample-notes'")).toEqual([{ version: 1, value: "true" }]);
  });

  it("切っている間は、形の違う本文でも 400 や 422 でなく 404 を返す", async () => {
    expect(await api(world, "PUT", "/api/v1/ext/sample-notes/note", { body: 1, extra: true }, 404)).toMatchObject({ code: "not_found" });
    const res = await world.gate.request("/api/v1/ext/sample-notes/note", { method: "PUT", headers: { ...world.headers, "Content-Type": "application/json" }, body: "{" });
    expect(res.status).toBe(404);
    // 入れると本文を確かめる
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now() + 15 * MINUTE).run();
    await api(world, "PUT", "/api/v1/extensions/sample-notes", { enabled: true });
    await api(world, "PUT", "/api/v1/ext/sample-notes/note", { body: 1 }, 422);
  });
});
