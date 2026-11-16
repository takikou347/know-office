// 通知の返す形 (サービスと拡張の 3.5、データの 2.6)
import { z } from "./zod.ts";

/** 通知の重さ。知らせ、注意、止めた */
export const NoticeLevel = z.enum(["info", "warn", "stop"]);

/** 通知の重さの型 */
export type NoticeLevel = z.infer<typeof NoticeLevel>;

/** 通知から開く画面の中の道。外への道、// で始まるほかのオリジンへの道、javascript: を入れない */
export const NoticeLink = z.string().max(200).regex(/^\/(?!\/)[a-z0-9/-]*$/);

/** 通知 1 件。本文の無い通知は空の文で返す */
export const Notice = z
  .object({
    id: z.uuid().openapi({ description: "UUID v7" }),
    at: z.iso.datetime(),
    level: NoticeLevel,
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    scope: z.string().openapi({ description: "`office` またはサービスの ID" }),
    readAt: z.iso.datetime().nullable(),
    link: NoticeLink.nullable().openapi({ description: "画面の中の開く先 (例 `/approvals/<承認 ID>`)。無ければ null" }),
  })
  .strict()
  .meta({ id: "Notice" });

/** 通知の型 */
export type Notice = z.infer<typeof Notice>;
