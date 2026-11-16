// オーナーの情報を項目ごとに暗号にして置き、社員のツール owner_info_read が許した 1 項目だけを、オーナーの情報を扱う拡張のルートがパスキーの確認の後に戻し、読んだ記録を残す (社員が考えるの 3.4、3.5、サービスと拡張の 3.8)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, deriveKey, fromBase64, newId, type StaffId, toBase64 } from "@know-office/core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { ownerData, ownerDataReads } from "../db/main.ts";
import { clockAt } from "./attendance.ts";

/** AES-GCM の iv の長さ */
const IV_BYTES = 12;

/**
 * 項目の名前を追加の認証データにする。ほかの項目の暗号文を写しても戻せなくする
 * @param extId 拡張 ID
 * @param field 項目
 * @returns 追加の認証データ
 */
function aad(extId: string, field: string): Uint8Array<ArrayBuffer> {
  // Workers の型の TextEncoder は ArrayBufferLike を返すので、ArrayBuffer の物に写す
  return new Uint8Array(new TextEncoder().encode(`${extId}.${field}`));
}

/**
 * オーナーの情報の 1 項目を暗号にする。鍵は deriveKey(MASTER_KEY, "owner-data")
 * @param master MASTER_KEY
 * @param extId 拡張 ID
 * @param field 項目
 * @param value 値
 * @returns base64 の暗号文と iv
 */
export async function sealOwnerData(master: string, extId: string, field: string, value: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await deriveKey(master, "owner-data");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(extId, field) }, key, new TextEncoder().encode(value));
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

/**
 * オーナーの情報の 1 項目を暗号にして置き換える。同じ拡張と項目の前の行を消して足すのを 1 回のバッチで書き、同時に置いても 1 行にする
 * @param db 今の状態の D1
 * @param master MASTER_KEY
 * @param item 拡張 ID と項目と値
 * @param item.extId 拡張 ID
 * @param item.field 項目
 * @param item.value 値
 * @param now 今の時刻
 */
export async function putOwnerData(db: D1Database, master: string, item: { extId: string; field: string; value: string }, now: number): Promise<void> {
  const { ciphertext, iv } = await sealOwnerData(master, item.extId, item.field, item.value);
  const orm = drizzle(db);
  await orm.batch([
    orm.delete(ownerData).where(and(eq(ownerData.extId, item.extId), eq(ownerData.field, item.field))),
    orm.insert(ownerData).values({ id: newId(clockAt(now)), extId: item.extId, field: item.field, ciphertext, iv, updatedAt: now }),
  ]);
}

/**
 * オーナーの情報の 1 項目を戻し、読んだ記録を owner_data_reads に 1 行足す。許した項目かは呼ぶ前にルールの判断が確かめる
 * @param db 今の状態の D1
 * @param master MASTER_KEY
 * @param read 読む項目と読んだ社員とタスク
 * @param read.extId 拡張 ID
 * @param read.field 項目
 * @param read.staffId 読んだ社員
 * @param read.nodeId 読んだタスク
 * @param now 今の時刻
 * @returns 値
 * @throws not_found 項目が無い時
 * @throws internal 戻せない時。中身も鍵も文に入れない
 */
export async function readOwnerData(db: D1Database, master: string, read: { extId: string; field: string; staffId: StaffId; nodeId: string }, now: number): Promise<string> {
  const value = await openOwnerData(db, master, { extId: read.extId, field: read.field, by: read.staffId, nodeId: read.nodeId }, now);
  if (value === null) throw new AppError("not_found", "その項目は無い");
  return value;
}

/**
 * オーナーの情報の 1 項目を戻し、戻せた時だけ読んだ記録を owner_data_reads に 1 行足す
 * @param db 今の状態の D1
 * @param master MASTER_KEY
 * @param read 読む項目と読んだ者とタスク
 * @param read.extId 拡張 ID
 * @param read.field 項目
 * @param read.by 読んだ者。社員 ID か owner
 * @param read.nodeId 読んだタスク。オーナーが画面で読んだ時は null
 * @param now 今の時刻
 * @returns 値。項目が無ければ null
 * @throws internal 戻せない時。中身も鍵も文に入れない
 */
export async function openOwnerData(db: D1Database, master: string, read: { extId: string; field: string; by: StaffId | "owner"; nodeId: string | null }, now: number): Promise<string | null> {
  const [row] = await drizzle(db)
    .select()
    .from(ownerData)
    .where(and(eq(ownerData.extId, read.extId), eq(ownerData.field, read.field)))
    .limit(1);
  if (!row) return null;
  const iv = fromBase64(row.iv);
  const sealed = fromBase64(row.ciphertext);
  if (iv?.length !== IV_BYTES || !sealed) throw new AppError("internal", "オーナーの情報を戻せない");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(read.extId, read.field) }, await deriveKey(master, "owner-data"), sealed);
  } catch {
    throw new AppError("internal", "オーナーの情報を戻せない");
  }
  // 読んだ記録は戻せた時だけ残す。値は入れない
  await drizzle(db).insert(ownerDataReads).values({ id: newId(clockAt(now)), at: now, by: read.by, extId: read.extId, field: read.field, nodeId: read.nodeId });
  return new TextDecoder().decode(plain);
}
