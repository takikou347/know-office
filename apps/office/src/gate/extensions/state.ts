// 拡張を入れているかの読み書きと、拡張ごとの置き場 (サービスと拡張の 3.8)
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { AppError, newId } from "@know-office/core";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { settings } from "../db/main.ts";
import { clockAt } from "../work/attendance.ts";
import type { ExtensionDefinition, ExtensionStore } from "./define.ts";

/** 入れているかを置く `settings` のキーの頭。`extension.sample-notes` のように ID を続ける */
const KEY_PREFIX = "extension.";

/** 置き場のキーの形。拡張の置き場の外を指せないよう、/ と . を許さない */
const STORE_KEY = /^[a-z\d][a-z\d-]{0,63}$/;

/** 入れているかと、その版 */
export type ExtensionState = { enabled: boolean; version: number };

/**
 * 拡張ごとに、入れているかの最新の値を読む。行が無い拡張は切っている
 * @param db 今の状態の D1
 * @param extensions 読み込んだ拡張
 * @returns 拡張 ID から、入れているかと版への対応
 */
export async function extensionStates(db: D1Database, extensions: readonly ExtensionDefinition[]): Promise<Map<string, ExtensionState>> {
  const rows = await drizzle(db)
    .select({ key: settings.key, value: settings.value, version: settings.version })
    .from(settings)
    .where(and(eq(settings.scope, "office"), like(settings.key, `${KEY_PREFIX}%`)))
    .orderBy(desc(settings.version));
  const out = new Map<string, ExtensionState>(extensions.map((e) => [e.id, { enabled: false, version: 0 }]));
  for (const e of extensions) {
    const row = rows.find((r) => r.key === `${KEY_PREFIX}${e.id}`);
    // 形の違う値は入れていない側に倒す
    if (row) out.set(e.id, { enabled: z.boolean().safeParse(row.value).data ?? false, version: row.version });
  }
  return out;
}

/**
 * 入れている拡張だけを返す
 * @param db 今の状態の D1
 * @param extensions 読み込んだ拡張
 * @returns 入れている拡張
 */
export async function enabledExtensions(db: D1Database, extensions: readonly ExtensionDefinition[]): Promise<ExtensionDefinition[]> {
  const states = await extensionStates(db, extensions);
  return extensions.filter((e) => states.get(e.id)?.enabled === true);
}

/**
 * 拡張を入れるか切る。`settings` に最新の版に 1 を足した行を足す。拡張のデータは消さない
 * @param db 今の状態の D1
 * @param input 拡張 ID、入れるか、今の時刻
 * @param input.id 拡張 ID
 * @param input.enabled 入れるか
 * @param input.now 今の時刻
 * @param current 読んだ今の版
 * @returns 足した行の版
 * @throws conflict 同時に入れ切りされ、版が進んでいた時
 */
export async function toggleExtension(db: D1Database, input: { id: string; enabled: boolean; now: number }, current: number): Promise<number> {
  const key = `${KEY_PREFIX}${input.id}`;
  const next = current + 1;
  const written = await drizzle(db)
    .insert(settings)
    .select(
      sql`SELECT ${newId(clockAt(input.now))}, ${key}, 'office', ${JSON.stringify(input.enabled)}, ${next}, 'owner', NULL, ${input.now} WHERE NOT EXISTS (SELECT 1 FROM ${settings} WHERE ${settings.key} = ${key} AND ${settings.scope} = 'office' AND ${settings.version} >= ${next})`,
    )
    .returning({ id: settings.id });
  if (written.length === 0) throw new AppError("conflict", "バージョンが違う");
  return next;
}

/**
 * 拡張ごとの置き場を作る。R2 の `ext/<拡張 ID>/` の下だけを読み書きする
 * @param files R2 の FILES
 * @param id 拡張 ID
 * @returns 置き場
 */
export function extensionStore(files: R2Bucket, id: string): ExtensionStore {
  const path = (key: string) => {
    if (!STORE_KEY.test(key)) throw new Error(`拡張の置き場のキーの形が違う: ${key}`);
    return `ext/${id}/${key}.json`;
  };
  return {
    get: async (key) => {
      const object = await files.get(path(key));
      return object === null ? null : (JSON.parse(await object.text()) as unknown);
    },
    put: async (key, value) => {
      await files.put(path(key), JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
    },
  };
}
