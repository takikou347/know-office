// 画面の JS に入れる Zod の言葉の訳を英語だけにする vite のプラグイン。
// core はスキーマに .openapi() を足すため Zod の z を丸ごと渡し (packages/core/src/schemas/zod.ts)、z.locales の 40 の言葉の訳が木から落ちずに入口の JS に残る。
// 画面は訳を選ばず、Zod が既定で使う英語だけを読む。gzip で 36 KB 減り、4G のダッシュボードを 2 秒以内に出す助けになる (画面の全体の 3.4)
import type { Plugin } from "vite";

const ENGLISH_ONLY = "\0know-office-zod-locales-en";

/**
 * Zod の中から読む言葉の訳の一覧 (v4/locales/index.js) を、英語だけの一覧に替えるプラグインを作る
 * @returns vite のプラグイン。build の画面 (client) だけに掛かる
 */
export function zodEnglishOnly(): Plugin {
  return {
    name: "know-office-zod-english-only",
    apply: "build",
    // vite の解決より先に受ける。後に置くと、Zod の中の相対の読み込みは vite が先に解いてしまう
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "client",
    resolveId(source, importer) {
      if (source !== "../locales/index.js" || !importer || !/[\\/]zod[\\/]v4[\\/](classic|core|mini)[\\/]/.test(importer)) return undefined;
      return ENGLISH_ONLY;
    },
    load(id) {
      if (id !== ENGLISH_ONLY) return undefined;
      return 'export { default as en } from "zod/v4/locales/en.js";\n';
    },
  };
}
