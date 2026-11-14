// 実行中に作る鍵を D1 の vault に MASTER_KEY の AES-GCM で暗号にして置く (データの 2.1 の vault)
import { AppError, type Clock } from "@know-office/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import { vault } from "../db/main.ts";

/** vault に置く鍵の名前 */
export type VaultName = "session_signing";

const bytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
const b64 = (data: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(data)));

/**
 * MASTER_KEY を AES-GCM の鍵にする
 * @param masterKey 32 バイトを base64 で
 * @returns 暗号の鍵
 * @throws internal MASTER_KEY が 32 バイトでない時
 */
async function importMasterKey(masterKey: string): Promise<CryptoKey> {
  const raw = bytes(masterKey);
  if (raw.length !== 32) throw new AppError("internal", "MASTER_KEY が 32 バイトでない");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * 名前の鍵を読む。無ければ 32 バイトの乱数で作って置く
 * @param db 今の状態の D1
 * @param name 鍵の名前
 * @param master MASTER_KEY
 * @param clock 時刻
 * @returns 鍵のバイト列
 */
export async function vaultKey(db: D1Database, name: VaultName, master: string, clock: Clock): Promise<Uint8Array<ArrayBuffer>> {
  const orm = drizzle(db);
  const key = await importMasterKey(master);
  const read = async () =>
    (
      await orm
        .select()
        .from(vault)
        .where(and(eq(vault.name, name), isNull(vault.revokedAt)))
        .orderBy(desc(vault.version))
        .limit(1)
    )[0];
  let stored = await read();
  if (!stored) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, crypto.getRandomValues(new Uint8Array(32)));
    // 2 つの要求が同時に作っても、主の鍵 (name、version) で 1 つだけが入る。入らなかった側は入った方を読み直す
    await orm.insert(vault).values({ name, ciphertext: b64(ciphertext), iv: b64(iv), version: 1, createdAt: clock.now() }).onConflictDoNothing();
    stored = await read();
  }
  if (!stored) throw new AppError("internal", "vault に鍵を置けない");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(stored.iv) }, key, bytes(stored.ciphertext)));
}
