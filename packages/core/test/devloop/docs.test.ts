// 設計書の形の確かめ (開発の回し方の 3.2)。ファイルの一覧と中身から、外れた所を返す
import { describe, expect, it } from "vitest";
import { checkServiceDocs, docsMergeNeeds, serviceDirs } from "../../src/index.ts";

const README = ["---", "name: demo", "summary: 小さな物", "repo: example/demo", "kind: app", "status: planning", "visibility: private", "---", "", "# demo"].join("\n");

const DETAIL = ["# 詳細設計 1. 動画", "", "## 1. 要件", "", "- **動画を作る**: 文章から作る", "- **動画を見る**: 一覧で見る", "", "## 2. 作る物", "", "- **ここは要件でない**: 2 章の項目"].join("\n");

const TEST = ["# テスト設計 1. 動画", "", "## 1. テストの置き場", "", "## 2. 要件ごとのシナリオ", "", "### 2.1 動画を作る", "", "| シナリオ | 場面 | 層 |", "", "### 2.2 動画を見る"].join("\n");

/**
 * 形の合う設計書のファイルを作る
 * @param change 足すか差し替えるファイル。null は消す
 * @returns 道と中身
 */
function docs(change: Record<string, string | null> = {}): Map<string, string> {
  const base: Record<string, string> = {
    "README.md": README,
    "docs/01-overview/index.md": "# 概要",
    "docs/04-detail/index.md": "# 詳細設計",
    "docs/04-detail/1-video.md": DETAIL,
    "docs/05-test/index.md": "# テスト設計",
    "docs/05-test/1-video.md": TEST,
  };
  for (const [path, body] of Object.entries(change)) {
    if (body === null) delete base[path];
    else base[path] = body;
  }
  return new Map(Object.entries(base));
}

/**
 * n 行の文書を作る
 * @param n 行の数
 * @returns 文書
 */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `行 ${String(i)}`).join("\n");
}

/**
 * 外れた所の道だけを返す
 * @param change 変える所
 * @param name サービスの名前
 * @returns 外れた所の道
 */
function problemPaths(change: Record<string, string | null>, name = "demo"): string[] {
  return checkServiceDocs(name, docs(change)).map((p) => p.path);
}

describe("決まった形の設計書", () => {
  it("形の違う設計書", () => {
    // 形の合う設計書は外れない
    expect(checkServiceDocs("demo", docs())).toEqual([]);

    // README.md の値の組。name の食い違い、種類と状態と公開の外れ、repo と summary の欠け、無い README
    expect(problemPaths({ "README.md": README.replace("name: demo", "name: other") })).toEqual(["README.md"]);
    for (const [from, to] of [["kind: app", "kind: game"], ["status: planning", "status: done"], ["visibility: private", "visibility: secret"], ["repo: example/demo\n", ""], ["summary: 小さな物\n", ""]] as const) {
      expect(problemPaths({ "README.md": README.replace(from, to) })).toEqual(["README.md"]);
    }
    expect(problemPaths({ "README.md": "# 値の組が無い" })).toEqual(["README.md"]);
    expect(problemPaths({ "README.md": null })).toEqual(["README.md"]);

    // docs/ の下の置き場。番号の無いフォルダ、機能のファイルの名前、01 の外のファイル
    expect(problemPaths({ "docs/notes/index.md": "# メモ" })).toEqual(["docs/notes/index.md"]);
    expect(problemPaths({ "docs/04-detail/Video.md": DETAIL })).toEqual(["docs/04-detail/Video.md"]);
    expect(problemPaths({ "docs/01-overview/extra.md": "# 余り" })).toEqual(["docs/01-overview/extra.md"]);

    // 1 ファイル 200 行まで。ちょうど 200 行は通り、201 行は外れる
    expect(problemPaths({ "docs/01-overview/index.md": lines(200) })).toEqual([]);
    expect(problemPaths({ "docs/01-overview/index.md": lines(201) })).toEqual(["docs/01-overview/index.md"]);

    // 詳細設計の機能のファイルは、1 章に要件 `- **<名前>**:` が 1 つ以上要る。2 章の項目は要件に数えない
    expect(problemPaths({ "docs/04-detail/1-video.md": "# 詳細設計\n\n## 1. 要件\n\n要件を書いていない\n\n## 2. 作る物\n\n- **ここは要件でない**: x" })).toContain("docs/04-detail/1-video.md");

    // テスト設計の機能のファイルは、詳細設計に対が要り、2 章の節の名前が詳細設計の要件の名前にある
    expect(problemPaths({ "docs/04-detail/1-video.md": null })).toEqual(["docs/05-test/1-video.md"]);
    expect(problemPaths({ "docs/05-test/1-video.md": TEST.replace("### 2.2 動画を見る", "### 2.2 動画を消す") })).toEqual(["docs/05-test/1-video.md"]);

    // app と library は 04-detail と 05-test の index.md が要り、tool は 01 だけでよい
    expect(problemPaths({ "docs/04-detail/index.md": null, "docs/05-test/index.md": null })).toEqual(["docs/04-detail/index.md", "docs/05-test/index.md"]);
    const tool = README.replace("kind: app", "kind: tool");
    expect(problemPaths({ "README.md": tool, "docs/04-detail/index.md": null, "docs/05-test/index.md": null, "docs/04-detail/1-video.md": null, "docs/05-test/1-video.md": null })).toEqual([]);
  });

  it("main に入れる条件と、変えた道から出すサービスの名前", () => {
    // 最初の設計書だけオーナーの承認も要る
    expect(docsMergeNeeds(true)).toEqual(["checks", "reviewer", "owner"]);
    expect(docsMergeNeeds(false)).toEqual(["checks", "reviewer"]);
    // 重ねずに、services/<名前>/ の下の名前だけを返す
    expect(serviceDirs(["services/a/README.md", "services/a/docs/01-overview/index.md", "services/b/README.md", "WRITING.md", "services/c"])).toEqual(["a", "b"]);
    expect(serviceDirs([])).toEqual([]);
  });
});
