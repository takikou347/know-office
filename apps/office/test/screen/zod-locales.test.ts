// 画面の JS に Zod の言葉の訳を英語だけ入れる事を確かめる。全部の言葉の訳は画面の最初の JS の 1 割を占め、4G で 2 秒以内に出す邪魔になる (画面の全体の 3.4)
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { zodEnglishOnly } from "../../scripts/zod-locales.ts";

/**
 * プラグインの resolveId と load を、vite の外から呼ぶ
 * @param plugin プラグイン
 * @returns 要求を置き場に解く関数と、置き場の中身を返す関数
 */
function hooks(plugin: Plugin): { resolve: (source: string, importer: string) => unknown; load: (id: string) => unknown } {
  const { resolveId, load } = plugin;
  if (typeof resolveId !== "function" || typeof load !== "function") throw new Error("resolveId と load が要る");
  return {
    resolve: (source, importer): unknown => Reflect.apply(resolveId, {}, [source, importer, { isEntry: false }]),
    load: (id): unknown => Reflect.apply(load, {}, [id]),
  };
}

describe("画面の JS の大きさ", () => {
  it("Zod が読む言葉の訳の一覧を、英語だけの一覧に替える", () => {
    const { resolve, load } = hooks(zodEnglishOnly());
    for (const importer of ["/repo/node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/external.js", "/repo/node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/index.js"]) {
      const id = resolve("../locales/index.js", importer);
      expect(typeof id).toBe("string");
      expect(load(String(id))).toBe('export { default as en } from "zod/v4/locales/en.js";\n');
    }
  });

  it("Zod の外のファイルと、言葉の訳のほかの読み込みは替えない", () => {
    const { resolve, load } = hooks(zodEnglishOnly());
    expect(resolve("../locales/index.js", "/repo/apps/office/src/screen/main.tsx")).toBeUndefined();
    expect(resolve("../locales/en.js", "/repo/node_modules/zod/v4/classic/external.js")).toBeUndefined();
    expect(load("/repo/node_modules/zod/v4/locales/index.js")).toBeUndefined();
  });

  it("build の画面だけに掛け、Worker とテストの Zod は替えない", () => {
    const plugin = zodEnglishOnly();
    expect(plugin.apply).toBe("build");
    expect(plugin.enforce).toBe("pre");
    const only = plugin.applyToEnvironment;
    if (typeof only !== "function") throw new Error("applyToEnvironment が要る");
    expect(Reflect.apply(only, undefined, [{ name: "client" }])).toBe(true);
    expect(Reflect.apply(only, undefined, [{ name: "know_office" }])).toBe(false);
  });
});
