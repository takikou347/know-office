// D1 の置き場ごとの使った量を読む。ストレージの一覧のルートと定期ジョブが使う (ログインと記録の 3.5)
import type { StorageUse } from "@know-office/core";
import type { Bindings } from "../env.ts";

/** D1 の 1 つのデータベースの上限 (10GB) */
export const STORAGE_LIMIT_BYTES = 10 * 1000 ** 3;

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
