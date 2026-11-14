// ルールの判断が Bash の命令を見る所。中身を読めない形、main への push、force、置き場の外の道を断る (社員が考えるの 3.4)
import { inside, protectedParent, protectedPath } from "./path.ts";

// 中身を判断できない形。$( とバッククォートは命令を、${ は道を隠す。{a,b} と {1..3} は語を増やす
const OPAQUE = [/\$\(/, /`/, /\$\{/, /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/];
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "fish"];
// git の前置きの引数のうち、次の語を値に取る物
const GIT_GLOBAL_VALUE = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"];
// git push の引数のうち、次の語を値に取る物
const PUSH_VALUE = ["-o", "--push-option", "--repo", "--receive-pack", "--exec"];
const PUSH_ALL = ["--all", "--branches", "--mirror"];
const CONFIG_READ = ["--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list"];
const MAIN = ["main", "master"];

/**
 * 命令を、つなぎ (&&、||、;、|、&、括弧、改行) で切った語の並びに分ける。引用符は外す
 * @param command シェルの命令
 * @returns つなぎごとの語の並び
 */
export function shellSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&\n()]/)
    .map((part) => part.replaceAll(/["']/g, " ").split(/[\s<>]+/).filter((w) => w !== ""))
    .filter((words) => words.length > 0);
}

/**
 * 語から道らしい所を取り出す。値付きの引数 (-o/x、--out=/x)、@ と { の頭を外す
 * @param word 命令の語
 * @returns 道らしい所の並び
 */
export function pathsOf(word: string): string[] {
  return word
    .split("=")
    .map((part) => part.replace(/^-+[A-Za-z]*(?=[/~.$])/, "").replace(/^[@{]+/, ""))
    .filter((part) => part === ".." || part.includes("/") || part.startsWith("~") || part.startsWith("$"));
}

/**
 * git push の引数を断る理由を探す。main 以外のブランチを明示した時だけ通す
 * @param args push の後の語
 * @returns 断る理由。通すなら null
 */
function pushRefusal(args: string[]): string | null {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i] ?? "";
    if (PUSH_VALUE.includes(w)) i += 1;
    else if (w.startsWith("--force") || /^-[A-Za-z]*f[A-Za-z]*$/.test(w) || w.startsWith("+")) return "force の push は断る";
    else if (PUSH_ALL.includes(w)) return "すべてのブランチの push は断る";
    else if (!w.startsWith("-")) positional.push(w);
  }
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return "ブランチを明示しない push は断る";
  for (const refspec of refspecs) {
    const dst = (refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec).replace(/^refs\/heads\//, "");
    if (dst === "" || dst === "HEAD") return "ブランチを明示しない push は断る";
    if (MAIN.includes(dst)) return "main への push は断る";
  }
  return null;
}

/**
 * 語の並びの中の git を探し、断る理由を探す。git は行のどこにあっても見る
 * @param words つなぎ 1 つ分の語
 * @returns 断る理由。通すなら null
 */
function gitRefusal(words: string[]): string | null {
  for (let i = 0; i < words.length; i += 1) {
    if ((words[i] ?? "").split("/").pop() !== "git") continue;
    let j = i + 1;
    while ((words[j] ?? "").startsWith("-")) j += GIT_GLOBAL_VALUE.includes(words[j] ?? "") ? 2 : 1;
    const args = words.slice(j + 1);
    if (words[j] === "push") {
      const refusal = pushRefusal(args);
      if (refusal !== null) return refusal;
    }
    if (words[j] === "config" && !args.some((w) => CONFIG_READ.includes(w))) return "git config の書き換えは断る";
  }
  return null;
}

/**
 * つなぎ 1 つ分の語を、git のほかの形で断る理由を探す
 * @param words つなぎ 1 つ分の語
 * @param workRoot 社員が触れてよい置き場
 * @param protectedPaths 書けない所
 * @returns 断る理由。通すなら null
 */
function wordsRefusal(words: string[], workRoot: string, protectedPaths: readonly string[]): string | null {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? "";
    const name = w.split("/").pop() ?? "";
    if (w === "eval" || (SHELLS.includes(name) && words.slice(i + 1).some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a)))) return "中身を判断できない命令は断る";
    if (w === "cd" || w === "pushd") {
      const to = words[i + 1];
      if (to === undefined || to === "-" || to.startsWith("~")) return `${workRoot} の外は触れない`;
      if (protectedParent(to, workRoot, protectedPaths)) return "ルールで触れない所には書けない";
    }
  }
  return gitRefusal(words);
}

/**
 * 命令を断る理由を探す。判断できない形は断る側に倒す
 * @param command シェルの命令
 * @param workRoot 社員が触れてよい置き場
 * @param protectedPaths 書けない所
 * @returns 断る理由。通すなら null
 */
export function shellRefusal(command: string, workRoot: string, protectedPaths: readonly string[]): string | null {
  if (OPAQUE.some((p) => p.test(command))) return "中身を判断できない命令は断る";
  if (/\s--force\b/.test(command)) return "--force は断る";
  if (protectedPaths.some((p) => command.includes(p.replace(/^\/+|\/+$/g, "")))) return "ルールで触れない所には書けない";
  for (const words of shellSegments(command)) {
    const refusal = wordsRefusal(words, workRoot, protectedPaths);
    if (refusal !== null) return refusal;
    const paths = words.flatMap(pathsOf);
    // 相対の道は置き場の頭から読む。cd で深く入った後の .. も、頭から読めば外に出るので断る側に倒れる
    if (!paths.every((p) => p !== ".." && inside(p, workRoot))) return `${workRoot} の外は触れない`;
    if (paths.some((p) => protectedPath(p, workRoot, protectedPaths))) return "ルールで触れない所には書けない";
  }
  return null;
}
