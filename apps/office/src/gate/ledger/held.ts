// 記録 DO の中で監査ログを書く記録係。年の置き場を開き、前の行のハッシュにつないで書く。D1 に書けない間 (毎日 4 時の写しの wrangler d1 export は、その D1 への要求を止める) は行を DO の storage に溜め、書けるようになったら順に書く (ログインと記録の 3.4、3.5、3.6)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, type AuditInput, type Clock, jstYear } from "@know-office/core";
import { type AuditRow, GENESIS_HASH, lastAuditHash, prepareAudit, writeAudit } from "./audit.ts";

/** 溜める行の上限。超えたら溜めずに断る。写しの数分に足りる数で、DO の storage を使い切らない */
export const HELD_LIMIT = 500;

/** 溜めた 1 行。年と、年の中の順の番号を持つ */
export type HeldAudit = AuditRow & { year: number; seq: number };

/** 記録係が使う DO の storage の口 */
export type LedgerStorage = {
  /**
   * 1 つ読む
   * @param key キー
   * @returns 値。無ければ undefined
   */
  get<T>(key: string): Promise<T | undefined>;
  /**
   * まとめて 1 回で書く
   * @param entries キーと値
   */
  put(entries: Record<string, unknown>): Promise<void>;
  /**
   * まとめて消す
   * @param keys キー
   */
  delete(keys: string[]): Promise<void>;
  /**
   * 頭の合うキーを辞書の順に読む
   * @param prefix キーの頭
   * @returns キーと値
   */
  list<T>(prefix: string): Promise<Map<string, T>>;
};

/** 記録係が外へ頼む口 */
export type LedgerDeps = {
  /** record_years を持つ本番の DB */
  main: D1Database;
  /**
   * 年の置き場を返す
   * @param year 年
   * @returns REC_<年>
   */
  binding(year: number): D1Database;
  /** DO の storage */
  storage: LedgerStorage;
  /** 時刻 */
  clock: Clock;
  /** 溜める上限。初期値は HELD_LIMIT */
  maxHeld?: number;
  /**
   * 溜めた事と書き直せなかった事を、ログとエラーログに残す。投げない
   * @param code 失敗の種類
   * @param error 元の失敗
   */
  report(code: string, error: unknown): Promise<void>;
};

type YearRow = { year: number; state: "writing" | "readonly"; first_hash: string | null };

const HELD = "held:";
const LAST = "last:";
const OPEN = "open:";

/**
 * 溜めた行のキー。年と 0 で埋めた順の番号で、辞書の順が書く順になる
 * @param row 年と順の番号
 * @param row.year 年
 * @param row.seq 順の番号
 * @returns キー
 */
function heldKey(row: { year: number; seq: number }): string {
  return `${HELD}${String(row.year)}:${String(row.seq).padStart(12, "0")}`;
}

/** 監査ログの記録係。記録 DO が 1 つ持ち、DO が起き直すと作り直す。覚えた物は DO の storage にも置く */
export class AuditLedger {
  readonly #deps: LedgerDeps;
  // 年ごとの最後のハッシュ。storage の last:<年> と同じ値
  readonly #last = new Map<number, string>();
  // 書いている年の最初の行の prev_hash。storage の open:<年> と同じ値
  readonly #open = new Map<number, string>();

  /**
   * @param deps 外へ頼む口
   */
  constructor(deps: LedgerDeps) {
    this.#deps = deps;
  }

  /**
   * 1 行足す。溜めた行があれば先に書き、残れば新しい行も後ろに溜める。D1 に書けなければ溜める
   * 前の行のハッシュはメモリ、DO の storage、D1 の順に読むので、DO が起き直した直後に D1 が止まっていても溜められる
   * @param input 頼まれた 1 件
   * @returns 足した行の id と hash と、溜めたか
   * @throws conflict その年がもう readonly の時
   * @throws unavailable 新しい年を開けない時、溜めた行が上限に届いた時
   */
  async append(input: AuditInput): Promise<{ id: string; hash: string; held: boolean }> {
    const year = jstYear(input.at);
    const startHash = await this.#openYear(year);
    const db = this.#deps.binding(year);
    const prev = await this.#lastHash(year, db, startHash);
    const row = await prepareAudit(prev, input, this.#deps.clock);
    const remaining = await this.flushYear(year);
    if (remaining === 0) {
      try {
        await writeAudit(db, row);
        await this.#remember(year, row.hash);
        return { id: row.id, hash: row.hash, held: false };
      } catch (error) {
        // 書き出しの間は落ちる。書けたのに落ちたと返った時も、溜めた行は ON CONFLICT で 2 度書かない
        await this.#hold(year, row, error);
        return { id: row.id, hash: row.hash, held: true };
      }
    }
    await this.#hold(year, row, new Error("前に溜めた行が残っている"));
    return { id: row.id, hash: row.hash, held: true };
  }

  /**
   * 溜めた行を全部の年で順に書く
   * @returns 残った行の数
   */
  async flush(): Promise<number> {
    const years = new Set([...(await this.#deps.storage.list<HeldAudit>(HELD)).values()].map((r) => r.year));
    let remaining = 0;
    for (const year of years) remaining += await this.flushYear(year);
    return remaining;
  }

  /**
   * その年の溜めた行を順に書く。落ちたら残りを溜めたままエラーログに残し、次に続ける
   * @param year 年
   * @returns 残った行の数
   */
  async flushYear(year: number): Promise<number> {
    const held = [...(await this.#deps.storage.list<HeldAudit>(`${HELD}${String(year)}:`)).values()];
    if (held.length === 0) return 0;
    let db: D1Database;
    try {
      db = this.#deps.binding(year);
    } catch (error) {
      await this.#deps.report("audit_flush_failed", error);
      return held.length;
    }
    for (const [i, row] of held.entries()) {
      try {
        await writeAudit(db, row);
      } catch (error) {
        await this.#deps.report("audit_flush_failed", error);
        return held.length - i;
      }
      await this.#deps.storage.delete([heldKey(row)]);
    }
    return 0;
  }

  /**
   * 1 行溜める。最後のハッシュと同じ 1 回で書く。上限に届いていれば溜めずに断る
   * @param year 年
   * @param row 溜める行
   * @param cause 溜める元になった失敗
   * @throws unavailable 上限に届いた時
   */
  async #hold(year: number, row: AuditRow, cause: unknown): Promise<void> {
    const held = [...(await this.#deps.storage.list<HeldAudit>(`${HELD}${String(year)}:`)).values()];
    if (held.length >= (this.#deps.maxHeld ?? HELD_LIMIT)) {
      await this.#deps.report("audit_held_full", cause);
      throw new AppError("unavailable", "監査ログを書けず、溜める上限に届いた");
    }
    const entry: HeldAudit = { ...row, year, seq: (held.at(-1)?.seq ?? 0) + 1 };
    await this.#deps.storage.put({ [heldKey(entry)]: entry, [`${LAST}${String(year)}`]: row.hash });
    this.#last.set(year, row.hash);
    await this.#deps.report("audit_held", cause);
  }

  /**
   * 書けた行のハッシュを覚える
   * @param year 年
   * @param hash 最後の行のハッシュ
   */
  async #remember(year: number, hash: string): Promise<void> {
    await this.#deps.storage.put({ [`${LAST}${String(year)}`]: hash });
    this.#last.set(year, hash);
  }

  /**
   * 年の最後のハッシュを、メモリ、DO の storage、D1 の順に読む。行が無ければその年の始まり
   * @param year 年
   * @param db REC_<年>
   * @param startHash その年の最初の行の prev_hash
   * @returns 最後のハッシュ
   */
  async #lastHash(year: number, db: D1Database, startHash: string): Promise<string> {
    const known = this.#last.get(year) ?? (await this.#deps.storage.get<string>(`${LAST}${String(year)}`));
    if (known !== undefined) return known;
    // storage に無いのは、前の版の記録 DO が書いた年だけ。D1 から 1 度読んで覚える
    const found = (await lastAuditHash(db)) ?? startHash;
    await this.#remember(year, found);
    return found;
  }

  /**
   * 書く年の置き場を開く。書いている年はメモリ、DO の storage、DB の順に読む。初めての年なら、前の年の溜めを書き終えてから前の年を readonly にし、前の年の最後のハッシュから続ける
   * @param year 年
   * @returns その年の最初の行の prev_hash
   * @throws conflict その年がもう readonly の時
   * @throws unavailable 前の年の溜めを書き終えられない時
   */
  async #openYear(year: number): Promise<string> {
    const known = this.#open.get(year) ?? (await this.#deps.storage.get<string>(`${OPEN}${String(year)}`));
    if (known !== undefined) {
      this.#open.set(year, known);
      return known;
    }
    const { main, storage } = this.#deps;
    const row = await main.prepare("SELECT year, state, first_hash FROM record_years WHERE year = ?").bind(year).first<YearRow>();
    // readonly の年に足すと、その年の最後のハッシュが次の年の first_hash と合わなくなる
    if (row?.state === "readonly") throw new AppError("conflict", `${String(year)} 年の記録は readonly で書けない`);
    if (row) {
      const start = row.first_hash ?? GENESIS_HASH;
      await storage.put({ [`${OPEN}${String(year)}`]: start });
      this.#open.set(year, start);
      return start;
    }
    const before = await main.prepare("SELECT year, state, first_hash FROM record_years WHERE year < ? ORDER BY year DESC LIMIT 1").bind(year).first<YearRow>();
    // 前の年の溜めが残ったまま新しい年を開くと、溜めた行が前の年の最後の行の後に入らない
    if (before && (await this.flushYear(before.year)) > 0) throw new AppError("unavailable", `${String(before.year)} 年の溜めた記録を書き終えていない`);
    const previousLast = before ? ((await lastAuditHash(this.#deps.binding(before.year))) ?? before.first_hash ?? GENESIS_HASH) : GENESIS_HASH;
    const statements = [main.prepare("INSERT INTO record_years (year, binding, state, first_hash, last_hash) VALUES (?, ?, 'writing', ?, NULL)").bind(year, `REC_${String(year)}`, previousLast)];
    if (before) statements.push(main.prepare("UPDATE record_years SET state = 'readonly', last_hash = ? WHERE year = ?").bind(previousLast, before.year));
    await main.batch(statements);
    if (before) {
      // 前の年は readonly になったので、書いている年として持たない
      await storage.delete([`${OPEN}${String(before.year)}`]);
      this.#open.delete(before.year);
    }
    await storage.put({ [`${OPEN}${String(year)}`]: previousLast, [`${LAST}${String(year)}`]: previousLast });
    this.#open.set(year, previousLast);
    this.#last.set(year, previousLast);
    return previousLast;
  }
}
