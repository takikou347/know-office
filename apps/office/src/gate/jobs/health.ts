// 5 分ごとの定期ジョブのうち、D1 の使った量を見る所 (ログインと記録の 3.5)
import { type Clock, newId, type StorageUse } from "@know-office/core";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { notices } from "../db/main.ts";
import type { Bindings } from "../env.ts";

/** D1 の 1 つのデータベースの上限 (10GB) */
export const STORAGE_LIMIT_BYTES = 10 * 1000 ** 3;
/** この割合に届いたら通知を出す */
const WARN_RATIO = 0.8;

/**
 * 置き場ごとの使った量を、上限に対する割合と一緒に読む
 * @param env バインディング
 * @returns 置き場の名前の順に並べた使った量
 */
export async function storageUses(env: Bindings): Promise<StorageUse[]> {
  const recorder = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
  const uses = await recorder.size();
  return uses
    .map(({ binding, bytes }) => ({ binding, bytes, ratio: Math.min(1, bytes / STORAGE_LIMIT_BYTES) }))
    .toSorted((a, b) => a.binding.localeCompare(b.binding));
}

/**
 * 上限の 8 割に届いた置き場があれば通知を出す。同じ置き場の通知は、オーナーが読むまで重ねて出さない
 * @param env バインディング
 * @param clock 時刻
 */
export async function checkStorage(env: Bindings, clock: Clock): Promise<void> {
  const orm = drizzle(env.DB);
  for (const use of await storageUses(env)) {
    if (use.ratio < WARN_RATIO) continue;
    const title = `記録の置き場 ${use.binding} が上限の 8 割に届いた`;
    const [open] = await orm
      .select({ id: notices.id })
      .from(notices)
      .where(and(eq(notices.kind, "storage"), eq(notices.title, title), isNull(notices.readAt)))
      .limit(1);
    if (open) continue;
    await orm.insert(notices).values({
      id: newId(clock),
      at: clock.now(),
      level: "warn",
      kind: "storage",
      title,
      body: `${(use.bytes / 1000 ** 3).toFixed(1)}GB / 10GB を使っている`,
      scope: "office",
    });
  }
}
