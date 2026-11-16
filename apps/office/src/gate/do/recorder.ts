// 記録 DO。監査ログを 1 件ずつ順に書き、年ごとの置き場を切り替える。写しの間など D1 に書けない時は行を溜めて後で書く (ログインと記録の 3.4、3.5)
import { DurableObject } from "cloudflare:workers";
import { AppError, AuditInput, type Clock, log, systemClock, jstYear } from "@know-office/core";
import type { D1Database } from "@cloudflare/workers-types";
import { type Bindings, RECORD_BINDINGS, type Recorder } from "../env.ts";
import { type ChainCheck, GENESIS_HASH, verifyChain } from "../ledger/audit.ts";
import { recordError } from "../ledger/errors.ts";
import { AuditLedger } from "../ledger/held.ts";

type YearRow = { year: number; binding: string; state: "writing" | "readonly"; first_hash: string | null; last_hash: string | null };

/** 溜めた行を書き直すまでの間 */
const FLUSH_RETRY_MS = 5 * 60_000;

/** 記録 DO。ゲートウェイと社員 DO だけが RPC で呼ぶ */
export class RecorderDO extends DurableObject<Bindings> implements Recorder {
  // 監査ログの記録係。DO が起き直すと作り直し、覚えた物は DO の storage から読み直す
  #ledger: AuditLedger | null = null;
  readonly #clock: Clock = systemClock;

  /**
   * 監査ログに 1 行足す。並んだ呼び出しも 1 件ずつ順に書く。D1 に書けない間は溜めて、5 分後に書き直す
   * @param input 頼まれた 1 件
   * @returns 足した行の id と hash
   * @throws validation_failed 入力の形が違う時
   * @throws conflict その年がもう readonly の時
   * @throws unavailable 溜めた行が上限に届いた時、前の年の溜めを書き終えずに新しい年を開こうとした時
   * @throws internal その年の置き場がバインドされていない時
   */
  async append(input: unknown): Promise<{ id: string; hash: string }> {
    const parsed = AuditInput.safeParse(input);
    if (!parsed.success) throw new AppError("validation_failed", "監査ログの形が違う");
    // D1 を待つ間に次の append が割り込むとハッシュチェーンが割れるので、ほかの呼び出しを止めて書く
    return await this.ctx.blockConcurrencyWhile(async () => {
      const written = await this.#ledgerOf().append(parsed.data);
      // 溜めた時は、書けるようになった頃に書き直す
      if (written.held && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(this.#clock.now() + FLUSH_RETRY_MS);
      return { id: written.id, hash: written.hash };
    });
  }

  /**
   * 溜めた行を年ごとに順に書く。残れば後でまた呼ぶ。書けなかった事は記録係がログとエラーログに残す
   */
  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const remaining = await this.#ledgerOf()
        .flush()
        .catch(async (error: unknown) => {
          await this.#report("audit_flush_failed", error);
          return 1;
        });
      if (remaining > 0) await this.ctx.storage.setAlarm(this.#clock.now() + FLUSH_RETRY_MS);
    });
  }

  /**
   * 記録係を作るか、作った物を返す
   * @returns 記録係
   */
  #ledgerOf(): AuditLedger {
    const storage = this.ctx.storage;
    this.#ledger ??= new AuditLedger({
      main: this.env.DB,
      binding: (year) => this.#binding(year),
      clock: this.#clock,
      storage: {
        get: (key) => storage.get(key),
        put: (entries) => storage.put(entries),
        delete: async (keys) => {
          await storage.delete(keys);
        },
        list: (prefix) => storage.list({ prefix }),
      },
      report: (code, error) => this.#report(code, error),
    });
    return this.#ledger;
  }

  /**
   * 溜めた事と書き直せなかった事を、ログとエラーログに残す。エラーログの D1 も止まっていれば、recordError がログにだけ残す
   * @param code 失敗の種類
   * @param error 元の失敗
   */
  async #report(code: string, error: unknown): Promise<void> {
    log("warn", code, { message: error instanceof Error ? error.message : String(error) });
    await recordError(this.env, { source: "recorder_do", level: "warn", code, error }, this.#clock);
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
