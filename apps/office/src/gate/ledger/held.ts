// 記録の D1 に書けない間 (毎日 4 時の写しの wrangler d1 export は、その D1 への要求を止める) に、記録 DO が監査ログの行を溜め、書けるようになったら順に書く (ログインと記録の 3.6)
import type { D1Database } from "@cloudflare/workers-types";
import type { AuditInput, Clock } from "@know-office/core";
import { type AuditRow, prepareAudit, writeAudit } from "./audit.ts";

/** 溜めた 1 行。年と、年の中の順の番号を持つ */
export type HeldAudit = AuditRow & { year: number; seq: number };

/** 溜める所。記録 DO では DO の storage */
export type HeldStore = {
  /**
   * その年の溜めた行を順の番号の順に返す
   * @param year 年
   * @returns 溜めた行
   */
  list(year: number): Promise<HeldAudit[]>;
  /**
   * 1 行溜める
   * @param row 溜める行
   */
  put(row: HeldAudit): Promise<void>;
  /**
   * 書けた行を消す
   * @param row 消す行
   */
  remove(row: HeldAudit): Promise<void>;
};

/**
 * 溜めた行を順に書く。落ちたら残りを溜めたまま止め、次に続ける
 * @param db その年の REC_<年>
 * @param store 溜める所
 * @param year 年
 * @returns 残った行の数
 */
export async function flushHeld(db: D1Database, store: HeldStore, year: number): Promise<number> {
  const held = await store.list(year);
  for (const [i, row] of held.entries()) {
    try {
      await writeAudit(db, row);
    } catch {
      return held.length - i;
    }
    await store.remove(row);
  }
  return 0;
}

/**
 * 1 行足す。溜めた行があれば先に書き、残れば新しい行も後ろに溜める。D1 に書けなければ溜める。溜めた行は DO の storage にあり、失われない
 * @param db その年の REC_<年>
 * @param store 溜める所
 * @param year 年
 * @param prevHash 前の行のハッシュ。溜めた行があればその最後の行のハッシュ
 * @param input 頼まれた 1 件
 * @param clock ID を作る時刻
 * @returns 足した行の id と hash と、溜めたか
 */
export async function appendOrHold(db: D1Database, store: HeldStore, year: number, prevHash: string, input: AuditInput, clock: Clock): Promise<{ id: string; hash: string; held: boolean }> {
  const row = await prepareAudit(prevHash, input, clock);
  const remaining = await flushHeld(db, store, year);
  if (remaining === 0) {
    try {
      await writeAudit(db, row);
      return { id: row.id, hash: row.hash, held: false };
    } catch {
      // 書き出しの間は落ちる。書けたのに落ちたと返った時も、溜めた行は ON CONFLICT で 2 度書かない
    }
  }
  const last = (await store.list(year)).at(-1);
  await store.put({ ...row, year, seq: (last?.seq ?? 0) + 1 });
  return { id: row.id, hash: row.hash, held: true };
}
