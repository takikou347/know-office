// 実行中に作る鍵を D1 の vault に、MASTER_KEY から作った vault 用の鍵の AES-GCM で暗号にして置く (データの 2.1 の vault、04-detail.md の 3.5)
import { AppError, type Clock, deriveKey, fromBase64, Secret, toBase64 } from "@know-office/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { vault } from "../db/main.ts";

/** vault に置く鍵の名前 */
export type VaultName = "session_signing" | "ticket_key";

/**
 * 名前の鍵を読む。無ければ 32 バイトの乱数で作って置く
 * @param db 今の状態の D1
 * @param name 鍵の名前
 * @param master MASTER_KEY
 * @param clock 時刻
 * @returns 鍵のバイト列
 * @throws internal 鍵を置けない、置いた鍵の形が違う時
 */
export async function vaultKey(db: D1Database, name: VaultName, master: string, clock: Clock): Promise<Uint8Array<ArrayBuffer>> {
  const orm = drizzle(db);
  const key = await deriveKey(master, "vault");
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
    await orm.insert(vault).values({ name, ciphertext: toBase64(ciphertext), iv: toBase64(iv), version: 1, createdAt: clock.now() }).onConflictDoNothing();
    stored = await read();
  }
  if (!stored) throw new AppError("internal", "vault に鍵を置けない");
  const iv = fromBase64(stored.iv);
  const ciphertext = fromBase64(stored.ciphertext);
  if (!iv || !ciphertext) throw new AppError("internal", "vault の鍵の形が違う");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
}

/** 外から受けて置く鍵の名前。GitHub App の元の鍵と、インストール */
export type StoredName = "github_app" | "github_installation";

/** 置いた鍵の今の値 */
export type Stored = {
  /** まだ使える最新の版の中身 (JSON の文字)。無いか、復号できなければ null */
  value: Secret | null;
  /** まだ使える最新の版。無ければ null */
  version: number | null;
  /** 取り消した物も入れた、いちばん大きい版。無ければ 0。次に書く時に比べる */
  top: number;
};

/**
 * 外から受けて置いた鍵を読み、復号する
 * @param db 今の状態の D1
 * @param name 鍵の名前
 * @param master MASTER_KEY
 * @returns まだ使える最新の版の中身と、いちばん大きい版
 */
export async function readStored(db: D1Database, name: StoredName, master: string): Promise<Stored> {
  const all = await drizzle(db).select().from(vault).where(eq(vault.name, name)).orderBy(desc(vault.version));
  const top = all[0]?.version ?? 0;
  const live = all.find((row) => row.revokedAt === null);
  if (!live) return { value: null, version: null, top };
  const iv = fromBase64(live.iv);
  const ciphertext = fromBase64(live.ciphertext);
  if (!iv || !ciphertext) return { value: null, version: live.version, top };
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await deriveKey(master, "vault"), ciphertext);
    return { value: new Secret(new TextDecoder().decode(plain)), version: live.version, top };
  } catch {
    // 全体を止めた時に乱数へ取り替えた鍵も、復号できても中身の形で断られる。ここでは読めない物を無い物とする
    return { value: null, version: live.version, top };
  }
}

/**
 * 外から受けた鍵を、読んだ時のいちばん大きい版の次に置く文を作る。同じ版から書いた 2 つは片方だけが入る。前の版はすべて取り消す
 * 呼ぶ側が 1 回の batch に入れ、1 つ目の文の書けた件数で入ったかを決める
 * @param db 今の状態の D1
 * @param input 名前、中身、読んだ版、時刻、書く時の条件
 * @param input.name 鍵の名前
 * @param input.value 中身
 * @param input.top 読んだ時のいちばん大きい版
 * @param input.now 今の時刻
 * @param input.master MASTER_KEY
 * @param input.when 足す条件の SQL と値。WHERE に AND でつなぐ
 * @param input.when.sql 条件の SQL
 * @param input.when.args 条件の値
 * @returns 入れる文と、前の版を取り消す文
 */
export async function storeStatements(
  db: D1Database,
  input: { name: StoredName; value: Secret; top: number; now: number; master: string; when?: { sql: string; args: unknown[] } },
): Promise<[D1PreparedStatement, D1PreparedStatement]> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(input.master, "vault"), new TextEncoder().encode(input.value.reveal()));
  const when = input.when ?? { sql: "1 = 1", args: [] };
  const next = input.top + 1;
  return [
    db
      .prepare(
        `INSERT INTO vault (name, ciphertext, iv, version, created_at, revoked_at) SELECT ?, ?, ?, ?, ?, NULL WHERE (SELECT COALESCE(MAX(version), 0) FROM vault WHERE name = ?) = ? AND (${when.sql})`,
      )
      .bind(input.name, toBase64(ciphertext), toBase64(iv), next, input.now, input.name, input.top, ...when.args),
    db
      // 新しい版が入った時だけ前の版を取り消す。入らなかった時は、入れた側が同じ事をしている
      .prepare("UPDATE vault SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL AND version < ? AND EXISTS (SELECT 1 FROM vault WHERE name = ? AND version = ?)")
      .bind(input.now, input.name, next, input.name, next),
  ];
}

/**
 * vault のまだ使える鍵をすべて新しいバージョンに取り替え、古いバージョンに revoked_at を入れる。全体を止めた時に呼ぶ (自動停止の 3.5)
 * @param db 今の状態の D1
 * @param master MASTER_KEY
 * @param now 今の時刻
 * @returns 取り替えた鍵の名前
 */
export async function rotateVaultKeys(db: D1Database, master: string, now: number): Promise<string[]> {
  const orm = drizzle(db);
  const key = await deriveKey(master, "vault");
  const live = await orm.select().from(vault).where(isNull(vault.revokedAt));
  const statements = [];
  for (const old of live) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, crypto.getRandomValues(new Uint8Array(32)));
    statements.push(
      orm.insert(vault).values({ name: old.name, ciphertext: toBase64(ciphertext), iv: toBase64(iv), version: old.version + 1, createdAt: now }),
      orm.update(vault).set({ revokedAt: now }).where(and(eq(vault.name, old.name), eq(vault.version, old.version))),
    );
  }
  const [first, ...rest] = statements;
  if (first) await orm.batch([first, ...rest]);
  return live.map((row) => row.name);
}
