// Web アプリを前のバージョンに戻す。オーナーが手で戻す時と、自動停止がサービスを止めた時が同じ道を通り、サービスごとに 10 分に 1 度、止めた記録ごとに 1 度だけ rollback.yml を動かす (サービスと拡張の 3.2、自動停止の 3.3)
import { AppError, type Deployment, newId, redactPublic } from "@know-office/core";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { claimLock, releaseLock } from "../db/locks.ts";
import { notices, serviceEvents } from "../db/main.ts";
import type { Bindings } from "../env.ts";
import { auditFrom } from "../ledger/record.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import type { Forge } from "../work/loop.ts";
import { findService } from "./flow.ts";

/** 戻した後に、同じサービスを次に戻せるまでの間。戻した版のデプロイの通知が届き、様子が落ち着くまで重ねて戻さない */
export const ROLLBACK_COOLDOWN_MS = 10 * 60_000;

/**
 * 戻しの錠の名前。デプロイもこの錠が持たれている間は走らせない
 * @param serviceId サービス ID
 * @returns 錠の名前
 */
export const rollbackLockName = (serviceId: string): string => `service.rollback:${serviceId}`;

/** 戻す workflow。そのリポジトリの .github/workflows/ に置く */
export const ROLLBACK_WORKFLOW = "rollback.yml";

/** workflow の入力に入れる理由の長さの上限。GitHub の入力の値は 1 つ 65,535 字までなので十分に短くする */
const REASON_MAX = 500;

/**
 * Web アプリを前のバージョンに戻す。錠を取った 1 つだけが GitHub に送り、送れた時だけ戻した記録と通知を残す
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param input サービス、誰が、理由、止めた記録、今の時刻
 * @param input.serviceId サービス ID
 * @param input.by `owner` (手で戻す) か `system` (自動停止)
 * @param input.reason 理由
 * @param input.stopId 自動停止の止めた記録の ID。手で戻す時は無い
 * @param input.now 今の時刻
 * @returns 受け付け。自動停止で、直前に戻したか同じ止めた記録で戻した時は null
 * @throws not_found サービスが無い時
 * @throws conflict Web アプリでない時、リポジトリが無い時、手で戻す時に直前に戻していた時
 * @throws upstream_failed GitHub が失敗を返した時。錠を外し、何も残さない
 */
export async function rollbackService(env: Bindings, forge: Forge, input: { serviceId: string; by: "owner" | "system"; reason: string; stopId?: string; now: number }): Promise<Deployment | null> {
  const { serviceId, by, now } = input;
  const row = await findService(env.DB, serviceId);
  if (row.kind !== "web_app") throw new AppError("conflict", "Web アプリでないので戻せない");
  if (row.repo === null) throw new AppError("conflict", "リポジトリが無いので戻せない");
  const id = newId(clockAt(now));
  const lock = rollbackLockName(serviceId);
  // 錠は 1 文の条件付きの書きで取り、切れるまで持ったままにする。同時の 2 つと直前の戻しは送らない
  if (!(await claimLock(env.DB, { name: lock, holder: id, now, ttlMs: ROLLBACK_COOLDOWN_MS }))) {
    if (by === "system") return null;
    throw new AppError("conflict", "直前に戻したか、戻している最中");
  }
  if (input.stopId !== undefined) {
    // 錠を持つ間はほかに戻す者がいないので、読んでから決めてよい
    const [done] = await drizzle(env.DB)
      .select({ id: serviceEvents.id })
      .from(serviceEvents)
      .where(and(eq(serviceEvents.serviceId, serviceId), eq(serviceEvents.kind, "rollback"), sql`json_extract(${serviceEvents.detail}, '$.stopId') = ${input.stopId}`))
      .limit(1);
    if (done) {
      await releaseLock(env.DB, lock, id);
      return null;
    }
  }
  const reason = redactPublic(input.reason).slice(0, REASON_MAX);
  let ref: string;
  try {
    ref = await forge.dispatchWorkflow(row.repo, ROLLBACK_WORKFLOW, { reason });
  } catch (error) {
    await releaseLock(env.DB, lock, id);
    if (error instanceof AppError) throw error;
    throw new AppError("upstream_failed", "GitHub に戻しを頼めない");
  }
  const orm = drizzle(env.DB);
  try {
    await orm.batch([
      orm.insert(serviceEvents).values({ id, at: now, serviceId, kind: "rollback", by, detail: { reason: input.reason, ref, stopId: input.stopId ?? null } }),
      orm.insert(notices).values({ id: newId(clockAt(now)), at: now, level: "info", kind: "service_rollback", title: `${row.name} を前のバージョンに戻した`, body: input.reason, scope: serviceId }),
    ]);
  } catch (error) {
    // 戻しは GitHub に届いている。記録が無いまま次の戻しを重ねないよう錠は持ったままにし、オーナーに知らせる
    await recordError(env, { source: "gate", level: "error", code: "service_rollback_unrecorded", error }, clockAt(now));
    await orm
      .insert(notices)
      .values({ id: newId(clockAt(now)), at: now, level: "warn", kind: "service_rollback_unrecorded", title: `${row.name} を戻したが、記録を書けなかった`, body: "GitHub の rollback.yml の実行を確かめる", scope: serviceId })
      .catch(() => undefined);
  }
  if (by === "system") await auditFrom(env, { at: now, actor: "system", action: "service.rollback", target: serviceId, scope: serviceId, detail: { reason, ref, stopId: input.stopId ?? null } });
  return { id, status: "queued" };
}
