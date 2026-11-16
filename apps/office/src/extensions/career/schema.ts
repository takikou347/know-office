// 職務経歴の拡張の形。ゲートウェイと画面が共に使う
import { z } from "zod";

/** 職務経歴の項目。項目ごとに暗号にして置く */
export const CAREER_FIELDS = ["summary", "history", "skills"] as const;

/** 職務経歴の項目の型 */
export type CareerField = (typeof CAREER_FIELDS)[number];

/** 項目の画面の名前 */
export const CAREER_FIELD_LABEL: Readonly<Record<CareerField, string>> = { summary: "自己紹介", history: "経歴", skills: "できる事" };

/** 1 つの項目の値。4,000 字まで */
const FieldValue = z.string().max(4000);

/** 職務経歴。置いていない項目は空の文 */
export const CareerProfile = z.object({ summary: FieldValue, history: FieldValue, skills: FieldValue }).strict().meta({ id: "CareerProfile" });

/** 職務経歴の型 */
export type CareerProfile = z.infer<typeof CareerProfile>;

/** 職務経歴を置き換える入力 */
export const UpdateCareerProfileInput = z.object({ summary: FieldValue, history: FieldValue, skills: FieldValue }).strict().meta({ id: "UpdateCareerProfileInput" });

/** 職務経歴を置き換える入力の型 */
export type UpdateCareerProfileInput = z.infer<typeof UpdateCareerProfileInput>;

/** 人に見せるために書き出した項目と値。書き出していない項目は持たない */
export const CareerShowcase = z.object({ items: z.record(z.string(), z.string()) }).strict().meta({ id: "CareerShowcase" });

/** 書き出した物の型 */
export type CareerShowcase = z.infer<typeof CareerShowcase>;

/** 人に見せる項目を選んで書き出す入力。同じ項目は 1 度だけ */
export const UpdateCareerShowcaseInput = z
  .object({ fields: z.array(z.enum(CAREER_FIELDS)).max(CAREER_FIELDS.length).refine((fields) => new Set(fields).size === fields.length, { message: "同じ項目を重ねない" }) })
  .strict()
  .meta({ id: "UpdateCareerShowcaseInput" });

/** 人に見せる項目を選んで書き出す入力の型 */
export type UpdateCareerShowcaseInput = z.infer<typeof UpdateCareerShowcaseInput>;

/** 書き出した物を読むツールの入力 */
export const ShowcaseReadTool = z.object({}).strict();
