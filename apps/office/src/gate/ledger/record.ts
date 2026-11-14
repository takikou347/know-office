// ルートから監査ログに 1 行頼む。書くのは記録 DO だけ (データの 3.4)
import type { Context } from "hono";
import type { GateEnv } from "../env.ts";

/**
 * 状態を変えた後に、記録 DO へ監査ログを 1 行頼む。actor はオーナー
 * @param c 要求の文脈
 * @param action 何をしたか (例: session.create)
 * @param target 対象の ID
 * @param detail 中身。鍵やトークンは入れない
 */
export async function audit(c: Context<GateEnv>, action: string, target: string | null, detail?: unknown): Promise<void> {
  const recorder = c.env.RECORDER.get(c.env.RECORDER.idFromName("recorder"));
  await recorder.append({ at: c.var.clock.now(), actor: "owner", action, target, scope: "office", detail, traceId: c.var.traceId });
}
