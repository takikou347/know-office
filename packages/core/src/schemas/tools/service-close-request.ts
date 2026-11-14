// 3 人のツール service_close_request の入力。サービスか運用の段階のサービスを閉じる案をオーナーに出す (サービスと拡張の 3.1 の 3)
import { z } from "../zod.ts";

/** service_close_request の入力 */
export const ServiceCloseRequestTool = z.object({ serviceId: z.uuid(), reason: z.string().min(1).max(2000) }).strict();

/** service_close_request の入力の型 */
export type ServiceCloseRequestTool = z.infer<typeof ServiceCloseRequestTool>;
