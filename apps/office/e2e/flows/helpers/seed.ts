// 利用場面の通しの種。画面からは作れない前提 (社員が出した承認、止めた記録など) を、開発の入口が使う手元の D1 に SQL で置く
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const office = join(import.meta.dirname, "../../..");

/**
 * 手元の主の D1 (DB) に SQL を流す。開発の入口 (vite の cloudflare) と同じ .wrangler/state を使うので、流した行は次の要求から読める
 * @param sql 流す SQL。値はテストが決めた物だけを入れ、外から来た文字を入れない
 */
export function seedMain(sql: string): void {
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", `--command=${sql}`], { cwd: office, stdio: "pipe" });
}
