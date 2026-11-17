// 設計書の決まった形。設計書のリポジトリの設定の鍵、形の確かめ、main に入れる条件 (開発の回し方の 3.2)
import { RepoName } from "../schemas/github.ts";
import type { ReleaseCondition } from "../schemas/settings.ts";
import { z } from "../schemas/zod.ts";

/** 設計書のリポジトリを置く `settings` のキー */
export const DOCS_REPO_KEY = "devloop.docs_repo";

/** 設定 `devloop.docs_repo` の値 */
export const DocsRepoValue = z.object({ repo: RepoName }).strict();

/** 設定 `devloop.docs_repo` の値の型 */
export type DocsRepoValue = z.infer<typeof DocsRepoValue>;

/** 設計書のリポジトリの今の値。まだ選んでいなければ repo は null で、version は 0 */
export const DocsRepo = z
  .object({ repo: RepoName.nullable().openapi({ description: "設計書のリポジトリ。まだ選んでいなければ null" }), version: z.number().int().openapi({ description: "設定の版。変える時に送り返す" }) })
  .strict()
  .meta({ id: "DocsRepo" });

/** 設計書のリポジトリの今の値の型 */
export type DocsRepo = z.infer<typeof DocsRepo>;

/** 設計書のリポジトリを選ぶ入力 */
export const UpdateDocsRepoInput = z
  .object({
    repo: RepoName.openapi({ description: "GitHub App で触れる非公開のリポジトリ。サービスのリポジトリは選べない" }),
    version: z.number().int().openapi({ description: "取得した時点のバージョン。現在と異なる場合は 409 conflict" }),
    reason: z.string().min(1).max(2000),
  })
  .strict()
  .meta({ id: "UpdateDocsRepoInput" });

/** 設計書のリポジトリを選ぶ入力の型 */
export type UpdateDocsRepoInput = z.infer<typeof UpdateDocsRepoInput>;

/** 設計書の外れた所。path は services/<名前>/ からの道 */
export type DocsProblem = { path: string; detail: string };

/** サービスの名前の形。設計書の置き場 `services/<名前>/` の道に入れるので、小文字、数字、`.`、`_`、`-` だけで、頭は英数字 */
export const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// 次の 3 つは knowidea の tools/check.py の SERVICE_DOCS、SERVICE_KEYS、FEATURE_FILE の物を、設計書のリポジトリの PR で確かめる分だけ写した形
const DOC_FOLDERS = ["01-overview", "02-architecture", "03-stack", "04-detail", "05-test", "06-operations"] as const;
const FEATURE_FILE = /^docs\/(04-detail|05-test)\/(\d+-[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;
const KEYS = { kind: ["app", "library", "tool"], status: ["planning", "building", "active", "retired"], visibility: ["public", "private"] } as const;

/** 1 ファイルの行の上限 */
const MAX_LINES = 200;

/**
 * README.md の頭の `---` で囲んだ値の組を読む
 * @param text README.md の中身
 * @returns キーと値。無ければ null
 */
function frontMatter(text: string): Record<string, string> | null {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) return null;
  return Object.fromEntries(
    lines
      .slice(1, end)
      .filter((l) => l.includes(":"))
      .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
  );
}

/**
 * 「## <番号>.」で始まる章の本文を返す
 * @param text 文書
 * @param chapter 章の番号
 * @returns 章の行。章が無ければ空
 */
function chapterOf(text: string, chapter: number): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${String(chapter)}.`));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * 詳細設計の 1 章の要件の名前を返す
 * @param text 詳細設計の機能のファイル
 * @returns 要件の名前
 */
function requirementNames(text: string): string[] {
  return chapterOf(text, 1).flatMap((l) => {
    const name = /^- \*\*(.+?)\*\*:/.exec(l)?.[1];
    return name === undefined ? [] : [name];
  });
}

/**
 * サービスの設計書の形を確かめる
 * @param name サービスの名前 (`services/<名前>/` の名前)
 * @param files `services/<名前>/` の下の道とその中身
 * @returns 外れた所。形が合えば空
 */
export function checkServiceDocs(name: string, files: ReadonlyMap<string, string>): DocsProblem[] {
  const problems: DocsProblem[] = [];
  const add = (path: string, detail: string) => void problems.push({ path, detail });
  const paths = [...files.keys()].toSorted();

  // README.md の値の組
  const readme = files.get("README.md");
  const front = readme === undefined ? null : frontMatter(readme);
  if (front === null) add("README.md", "頭に --- で囲んだ値の組が要る");
  else {
    if (front["name"] !== name) add("README.md", `name は ${name} にする`);
    for (const key of ["repo", "summary"]) if (!front[key]) add("README.md", `${key} が要る`);
    for (const [key, allowed] of Object.entries(KEYS)) if (!(allowed as readonly string[]).includes(front[key] ?? "")) add("README.md", `${key} は ${allowed.join("、")} のどれか`);
  }

  // services/<名前>/ の直下は README.md と docs/ だけ
  for (const path of paths) if (path !== "README.md" && !path.startsWith("docs/")) add(path, "services/<名前>/ の直下に置けるのは README.md と docs/ だけ");

  // docs/ の下の置き場。番号のフォルダの index.md と、04 と 05 の機能のファイルだけ
  const indexes = new Set(DOC_FOLDERS.map((d) => `docs/${d}/index.md`));
  for (const path of paths) {
    if (path.startsWith("docs/") && !indexes.has(path) && !FEATURE_FILE.test(path)) add(path, `docs/ に置けるのは ${DOC_FOLDERS.join("、")} の index.md と、04-detail と 05-test の <番号>-<名前>.md だけ`);
  }

  // 1 ファイル 200 行まで
  for (const path of paths) if ((files.get(path) ?? "").split("\n").length > MAX_LINES) add(path, `${String(MAX_LINES)} 行までにする`);

  // kind が app か library なら詳細設計とテスト設計の index.md が要る
  if (front !== null && (front["kind"] === "app" || front["kind"] === "library")) {
    for (const index of ["docs/04-detail/index.md", "docs/05-test/index.md"]) if (!files.has(index)) add(index, `kind が ${front["kind"]} のサービスに要る`);
  }

  // 詳細設計の機能のファイルは要件が 1 つ以上、テスト設計の機能のファイルは詳細設計に対があり、2 章の節が要件の名前にある
  for (const path of paths) {
    const feature = FEATURE_FILE.exec(path);
    const text = files.get(path) ?? "";
    if (feature?.[1] === "04-detail" && requirementNames(text).length === 0) add(path, "1 章に要件 `- **<名前>**:` が 1 つ以上要る");
    if (feature?.[1] !== "05-test") continue;
    const pair = files.get(`docs/04-detail/${feature[2] ?? ""}`);
    if (pair === undefined) {
      add(path, "詳細設計に同じ番号と名前の機能のファイルが要る");
      continue;
    }
    const names = requirementNames(pair);
    for (const line of chapterOf(text, 2)) {
      const section = /^### 2\.\d+ (.+?)\s*$/.exec(line)?.[1];
      if (section !== undefined && !names.includes(section)) add(path, `2 章の節 ${section} が詳細設計の要件の名前にない`);
    }
  }
  return problems;
}

/**
 * 設計書のリポジトリの PR が main に入る条件を返す。office とサービスの設定は読まない
 * @param first 既定のブランチにそのサービスの README.md がまだ無い、最初の設計書か
 * @returns 最初はチェック、レビュー担当、オーナー。後はチェックとレビュー担当
 */
export function docsMergeNeeds(first: boolean): ReleaseCondition[] {
  return first ? ["checks", "reviewer", "owner"] : ["checks", "reviewer"];
}

/**
 * 変えた道から、`services/<名前>/` の名前を重ねずに返す
 * @param paths 変えた道 (リポジトリの頭から)
 * @returns サービスの名前。出てきた順
 */
export function serviceDirs(paths: readonly string[]): string[] {
  const names = paths.flatMap((p) => {
    const parts = p.split("/");
    return parts[0] === "services" && parts.length > 2 && parts[1] ? [parts[1]] : [];
  });
  return [...new Set(names)];
}
