// 利用場面の通しの種。画面からは作れない前提 (社員が出した承認、止めた記録など) を、開発の入口が使う手元の D1 に SQL で置く
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const office = join(import.meta.dirname, "../../..");

/** 手元の D1 がほかの書き込みで塞がっている時に流し直す回数と間 */
const BUSY_TRIES = 3;
const BUSY_WAIT_MS = 300;

/**
 * 失敗が手元の D1 の塞がり (SQLITE_BUSY) による物か
 * @param error execFileSync が投げた物
 * @returns 塞がりなら true
 */
function busy(error: unknown): boolean {
  const output = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
  const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
  return /SQLITE_BUSY|database is locked/u.test(`${output}${stdout}${String(error)}`);
}

/**
 * 手元の D1 に pnpm のコマンドを流す。開発の入口の書き込みと重なって SQLITE_BUSY で断られた時は、間を空けて 3 回まで流し、ほかの失敗はそのまま投げる。流すコマンドは何度流しても同じ結果になる物だけにする
 * @param args pnpm に渡す引数
 */
export function runLocalD1(args: string[]): void {
  for (let tried = 1; ; tried += 1) {
    try {
      execFileSync("pnpm", args, { cwd: office, stdio: "pipe" });
      return;
    } catch (error) {
      if (tried >= BUSY_TRIES || !busy(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_WAIT_MS);
    }
  }
}

/**
 * 手元の主の D1 (DB) に SQL を流す。開発の入口 (vite の cloudflare) と同じ .wrangler/state を使うので、流した行は次の要求から読める
 * @param sql 流す SQL。値はテストが決めた物だけを入れ、外から来た文字を入れない
 */
export function seedMain(sql: string): void {
  runLocalD1(["exec", "wrangler", "d1", "execute", "DB", "--local", `--command=${sql}`]);
}

/**
 * 前に流した時に残った、その社員のまだ有効な指示を取り消す。day_orders は追記だけなので、入口と同じく取り消しの行を足す
 * @param staffId 社員
 */
export function cancelLeftOrders(staffId: string): void {
  const uuid = "lower(substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-7' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))";
  seedMain(
    `INSERT INTO day_orders (id, staff_id, day, kind, until, source, cancels, created_at) SELECT ${uuid}, staff_id, day, kind, NULL, 'button', id, ${String(Date.now())} ` +
      `FROM (SELECT hex(randomblob(16)) AS h, o.* FROM day_orders o WHERE o.staff_id = '${staffId}' AND o.cancels IS NULL AND NOT EXISTS (SELECT 1 FROM day_orders x WHERE x.cancels = o.id))`,
  );
}
