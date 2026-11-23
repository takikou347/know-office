// オーナーが画面で足すタスクの種類のマスタデータ。社長が分ける plan とレビュー担当の review は社員だけが作るので並べない (タスクとレビューの 1 章)
import { defineMaster } from "./master.ts";

/** オーナーが選べるタスクの種類 */
export const TASK_KINDS = defineMaster([
  { value: "build", label: "作る", note: "サービスを考えて作る" },
  { value: "content", label: "コンテンツ", note: "コンテンツを作る" },
  { value: "fix", label: "直す", note: "公開したサービスを直す" },
]);
