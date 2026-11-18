// レビューの画面の部品が knowidea-ui から来る事を確かめる。変更は DiffView、エディタは knowidea-ui/editor の CodeEditor で、画面が差分やエディタの仕組みを直に持たない (タスクとレビューの 3.2、要件 review のコンポーネントの置き場)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCREEN = join(import.meta.dirname, "../../src/screen");
const REVIEW = join(SCREEN, "pages/staff");

/**
 * 画面のファイルを集める
 * @param dir 探す所
 * @returns 道
 */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return files(join(dir, e.name));
    return /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [];
  });
}

/**
 * ファイルが読む物の名前を並べる
 * @param path ファイルの道
 * @returns import と import() の読む先
 */
function imports(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("コンポーネントの置き場", () => {
  it("コンポーネントを入れる", () => {
    const review = ["ReviewPage.tsx", "ReviewFiles.tsx", "ReviewEditor.tsx"].map((f) => readFileSync(join(REVIEW, f), "utf8"));
    // 変更は knowidea-ui の DiffView、エディタは knowidea-ui/editor の CodeEditor で組む
    expect(review.some((t) => /import \{[^}]*\bDiffView\b[^}]*\} from "knowidea-ui";/.test(t))).toBe(true);
    expect(review.some((t) => t.includes('import("knowidea-ui/editor").then((m) => ({ default: m.CodeEditor }))'))).toBe(true);
    // 画面は CodeMirror と差分の仕組みを直に読まない
    const direct = files(SCREEN).flatMap((f) => imports(f).filter((name) => /^@codemirror\/|^codemirror$|^diff$|^react-diff/.test(name)).map((name) => `${f}: ${name}`));
    expect(direct).toEqual([]);
  });
});
