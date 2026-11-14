// 画面の通しのテストが使う、オーナーのログインセッションのクッキーの置き場。ブラウザーごとに 1 つ
import { join } from "node:path";

/** ログインのプロジェクトの名前の頭。後ろにブラウザーの名前を付ける */
export const LOGIN_PROJECT = "login-";

/**
 * そのブラウザーのログインセッションのクッキーの置き場を返す。login.setup.ts が書き、同じブラウザーのテストが storageState で読む
 * @param browser playwright.config.ts のブラウザーの名前 (chrome、safari)
 * @returns ファイルの場所
 */
export function sessionState(browser: string): string {
  return join(import.meta.dirname, `../../test-results/.session-${browser}.json`);
}
