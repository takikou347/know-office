// サービスの設定を office の初期値と合わせて組み立てる (サービスと拡張の 3.3)
import type { D1Database } from "@cloudflare/workers-types";

/**
 * まだ作っていない
 * @param _db D1
 * @param _serviceId サービス ID
 * @returns 無い
 */
export function serviceRules(_db: D1Database, _serviceId: string): Promise<unknown> {
  return Promise.reject(new Error("まだ作っていない"));
}
