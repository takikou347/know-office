// 記録 DO。監査ログを 1 件ずつ順に書き、年ごとの置き場を切り替える (ログインと記録の 3.4、3.5)
import { DurableObject } from "cloudflare:workers";
import { AppError, AuditInput, systemClock, jstYear } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { type Bindings, RECORD_BINDINGS, type Recorder } from "../env.ts";
import { appendAudit, type ChainCheck, GENESIS_HASH, lastAuditHash, verifyChain } from "../ledger/audit.ts";

type YearRow = { year: number; binding: string; state: "writing" | "readonly"; first_hash: string | null; last_hash: string | null };

/** 記録 DO。ゲートウェイと社員 DO だけが RPC で呼ぶ */
export class RecorderDO extends DurableObject<Bindings> implements Recorder {
  // 年ごとの最後のハッシュ。起き直した時だけ D1 から読み直す
  #last = new Map<number, string>();

  /**
   * 監査ログに 1 行足す。並んだ呼び出しも 1 件ずつ順に書く
   * @param input 頼まれた 1 件
   * @returns 足した行の id と hash
   * @throws validation_failed 入力の形が違う時
   * @throws conflict その年がもう readonly の時
   * @throws internal その年の置き場がバインドされていない時
   */
  async append(input: unknown): Promise<{ id: string; hash: string }> {
    const parsed = AuditInput.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "監査ログの形が違う");
    // D1 を待つ間に次の append が割り込むとハッシュチェーンが割れるので、ほかの呼び出しを止めて書く
    return await this.ctx.blockConcurrencyWhile(async () => {
      const year = jstYear(parsed.data.at);
      const { db, startHash } = await this.#openYear(year);
      const prev = this.#last.get(year) ?? (await lastAuditHash(db)) ?? startHash;
      const written = await appendAudit(db, prev, parsed.data, systemClock);
      this.#last.set(year, written.hash);
      return written;
    });
  }

  /**
   * その年のハッシュチェーンを頭から確かめる
   * @param year 年
   * @returns 合うか、最初に合わなかった行
   * @throws not_found その年の置き場が無い時
   */
  async verify(year: number): Promise<ChainCheck> {
    const row = await this.env.DB.prepare("SELECT * FROM record_years WHERE year = ?").bind(year).first<YearRow>();
    if (!row) throw new AppError("not_found", `${String(year)} 年の記録が無い`);
    // 最初の年は前の年が無いので、first_hash は空で始まりの値から続く
    return verifyChain(this.#binding(year), row.first_hash ?? GENESIS_HASH);
  }

  /**
   * その時刻の年の監査ログから、操作と対象の合う最初の行の detail を読む。止めた記録の直前の出来事を読むのに使う
   * @param at 書いた時刻
   * @param action 操作
   * @param target 対象
   * @returns detail の JSON の文字列。行が無ければ null
   */
  async find(at: number, action: string, target: string): Promise<{ detail: string | null } | null> {
    const row = await this.#binding(jstYear(at)).prepare("SELECT detail FROM audit_log WHERE action = ? AND target = ? ORDER BY id LIMIT 1").bind(action, target).first<{ detail: string | null }>();
    return row ? { detail: row.detail } : null;
  }

  /**
   * バインドした D1 ごとの使った量を測る。5 分ごとの定期ジョブとストレージの一覧が呼ぶ
   * @returns DB と REC_<年> のうちバインドした物の、名前とバイト数
   */
  async size(): Promise<{ binding: string; bytes: number }[]> {
    const uses: { binding: string; bytes: number }[] = [];
    for (const binding of ["DB", ...RECORD_BINDINGS] as const) {
      const db = this.env[binding];
      // 先の年の置き場は作ってからバインドするので、まだ無い物は飛ばす
      if (!db) continue;
      // D1 はどの問い合わせの返事にも、その後の大きさを meta.size_after で返す
      const { meta } = await db.prepare("SELECT 1").run();
      uses.push({ binding, bytes: meta.size_after });
    }
    return uses;
  }

  /**
   * 書く年の置き場を開く。初めての年なら前の年を readonly にし、前の年の最後のハッシュから続ける
   * @param year 年
   * @returns 置き場と、その年の最初の行の prev_hash
   * @throws conflict その年がもう readonly の時
   */
  async #openYear(year: number): Promise<{ db: D1Database; startHash: string }> {
    const db = this.#binding(year);
    const row = await this.env.DB.prepare("SELECT * FROM record_years WHERE year = ?").bind(year).first<YearRow>();
    // readonly の年に足すと、その年の最後のハッシュが次の年の first_hash と合わなくなる
    if (row?.state === "readonly") throw new AppError("conflict", `${String(year)} 年の記録は readonly で書けない`);
    if (row) return { db, startHash: row.first_hash ?? GENESIS_HASH };
    // 初めての年: 前の年の最後のハッシュを読み、新しい年の行を足すのと前の年を readonly にするのを 1 つの batch で行う
    const before = await this.env.DB.prepare("SELECT * FROM record_years WHERE year < ? ORDER BY year DESC LIMIT 1").bind(year).first<YearRow>();
    const previousLast = before ? ((await lastAuditHash(this.#binding(before.year))) ?? before.first_hash ?? GENESIS_HASH) : GENESIS_HASH;
    const statements = [
      this.env.DB.prepare("INSERT INTO record_years (year, binding, state, first_hash, last_hash) VALUES (?, ?, 'writing', ?, NULL)").bind(year, `REC_${String(year)}`, previousLast),
    ];
    if (before) {
      statements.push(this.env.DB.prepare("UPDATE record_years SET state = 'readonly', last_hash = ? WHERE year = ?").bind(previousLast, before.year));
    }
    await this.env.DB.batch(statements);
    return { db, startHash: previousLast };
  }

  /**
   * 年の置き場を返す
   * @param year 年
   * @returns REC_<年> の D1
   * @throws internal バインドされていない時
   */
  #binding(year: number): D1Database {
    const name = RECORD_BINDINGS.find((b) => b === `REC_${String(year)}`);
    const db = name ? this.env[name] : undefined;
    if (!db) throw new AppError("internal", `REC_${String(year)} がバインドされていない`);
    return db;
  }
}
