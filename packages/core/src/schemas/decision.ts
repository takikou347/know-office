// ワークスペースのフックがゲートウェイにツールの可否を聞く入力と答え。名前は v1.yaml の components/schemas と同じ (社員が考えるの 3.4)
import { Meta } from "./common.ts";
import { z } from "./zod.ts";

/** POST /ws/v1/decisions の入力。toolInput は SDK が渡したままで、判断は toOperation() が形を見る */
export const DecideInput = z
  .object({ toolName: z.string(), toolInput: z.record(z.string(), z.unknown()) })
  .strict()
  .meta({ id: "DecideInput" });

/** ツールの可否を聞く入力の型 */
export type DecideInput = z.infer<typeof DecideInput>;

/** ツールの可否の答え */
export const Decision = z.object({ allow: z.boolean(), reason: z.string() }).strict().meta({ id: "Decision" });

/** ツールの可否の答えの型 */
export type Decision = z.infer<typeof Decision>;

/** POST /ws/v1/decisions の成功の返事の本文。フックが答えを確かめる */
export const DecideAnswer = z.object({ data: Decision, meta: Meta }).strict();

/** SDK が PreToolUse のフックに渡す入力のうち、判断に使う所。ほかの項目は見ない */
export const PreToolUseInput = z.object({ tool_name: z.string().min(1), tool_input: z.record(z.string(), z.unknown()) });
