// git の pre-commit フック (.githooks/pre-commit から呼ぶ)。公開リポジトリなので、作者と入れた者が KNOW IDEA である事と、
// 足した行に noreply でないメールアドレスが無い事を、コミットを作る前に数秒で確かめる。同じ確かめは CI の check にもある
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IDENT = "KNOW IDEA <noreply@knowidea.invalid>";
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// noreply の物、例の物、届かない事が決まっている名前 (RFC 2606 の .test、.example、.invalid、.localhost)、GitHub の bot は通す
const ALLOWED = /^(?:noreply@.+|.+@example\.(?:com|org|net)|.+\.(?:test|example|invalid|localhost)|\d+\+[^@]+\[bot\]@users\.noreply\.github\.com)$/;

/**
 * git var の作者か入れた者の名乗りを確かめる
 * @param ident `git var GIT_AUTHOR_IDENT` の出力。例 `KNOW IDEA <noreply@knowidea.invalid> 1731600000 +0900`
 * @returns 違う時の文。合っていれば undefined
 */
export function identProblem(ident: string): string | undefined {
  return ident.startsWith(`${IDENT} `) ? undefined : `作者と入れた者は ${IDENT} にする (git -c user.name="KNOW IDEA" -c user.email="noreply@knowidea.invalid" commit)`;
}

/**
 * 足した行にあるメールアドレスのうち、通さない物を返す
 * @param diff `git diff --cached -U0` の出力
 * @returns 通さないメールアドレス。無ければ空
 */
export function addedEmails(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .flatMap((line) => line.match(EMAIL) ?? [])
    .filter((email) => !ALLOWED.test(email));
}

function git(...args: string[]): string {
  const run = spawnSync("git", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} が落ちた: ${run.stderr}`);
  return run.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = [git("var", "GIT_AUTHOR_IDENT"), git("var", "GIT_COMMITTER_IDENT")].map((ident) => identProblem(ident.trim()));
  const emails = addedEmails(git("diff", "--cached", "-U0", "--no-color"));
  // メールアドレスそのものは出さない。CI の check と同じ
  const found = emails.length > 0 ? [`足した行に noreply でないメールアドレスが ${emails.length} 件ある`] : [];
  const messages = [...new Set([...problems.filter((p) => p !== undefined), ...found])];
  if (messages.length > 0) {
    for (const message of messages) console.error(message);
    process.exit(1);
  }
}
