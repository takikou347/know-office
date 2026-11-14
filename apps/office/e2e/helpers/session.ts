// 画面の通しの全部のテストが使う、オーナーのログインセッションのクッキーの置き場
import { join } from "node:path";

/** records.setup.ts が書き、各テストが storageState で読む */
export const SESSION_STATE = join(import.meta.dirname, "../../test-results/.session.json");
