// ワークスペースとゲートウェイ、社員 DO の間でやり取りする形と、作業トークンの中身 (社員が考えるの 1.2、1.3、2 章)
import { StaffId } from "./workday.ts";
import { z } from "./zod.ts";

/** POST /ws/v1/heartbeat の入力。送った時刻 */
export const HeartbeatInput = z.object({ at: z.iso.datetime() }).strict().meta({ id: "HeartbeatInput" });

/** ハートビートの型 */
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/** POST /v1/runs の入力。タスク 1 件分の SDK の呼び出し */
export const RunInput = z
  .object({
    nodeId: z.uuid(),
    ticket: z.string().min(1),
    model: z.string().min(1),
    effort: z.enum(["low", "medium", "high"]),
    systemPrompt: z.string(),
    prompt: z.string(),
    resume: z.string().min(1).optional(),
  })
  .strict()
  .meta({ id: "RunInput" });

/** タスク 1 件分の SDK の呼び出しの型 */
export type RunInput = z.infer<typeof RunInput>;

/** PUT /v1/ticket の入力。差し替える作業トークン */
export const TicketInput = z.object({ ticket: z.string().min(1) }).strict().meta({ id: "TicketInput" });

/** 作業トークンの差し替えの型 */
export type TicketInput = z.infer<typeof TicketInput>;

/** 作業トークン (HS256 の JWT) の中身。sub は社員、node はタスク、ws は発行した先のワークスペース、時刻は秒 */
export const WorkTicketClaims = z
  .object({
    sub: StaffId,
    node: z.uuid(),
    ws: z.string().min(1),
    jti: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

/** 作業トークンの中身の型 */
export type WorkTicketClaims = z.infer<typeof WorkTicketClaims>;
