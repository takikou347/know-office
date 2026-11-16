// 職務経歴の拡張。オーナーの経歴を項目ごとに暗号にして置き、開くたびにパスキーで確かめる。人に見せる項目だけを書き出し、見せるサービスの社員が showcase_read で読む (サービスと拡張の 3.8)
import { defineExtension, type ExtensionContext, type ExtensionStore } from "../../gate/extensions/define.ts";
import { CAREER_FIELDS, CareerProfile, CareerShowcase, ShowcaseReadTool, UpdateCareerProfileInput, UpdateCareerShowcaseInput } from "./schema.ts";

/** 書き出した物が無い時に返す物 */
const NOTHING: CareerShowcase = { items: {} };

/**
 * オーナーの情報の置き場を受ける。土台は ownerData の拡張のルートに必ず渡す
 * @param ctx 拡張の中身が受ける物
 * @returns オーナーの情報の置き場
 * @throws Error 渡されていない時
 */
function ownerDataOf(ctx: ExtensionContext): NonNullable<ExtensionContext["ownerData"]> {
  if (!ctx.ownerData) throw new Error("オーナーの情報の置き場が無い");
  return ctx.ownerData;
}

/**
 * 職務経歴を項目ごとに戻す。置いていない項目は空の文
 * @param ctx 拡張の中身が受ける物
 * @returns 職務経歴
 */
async function readProfile(ctx: ExtensionContext): Promise<CareerProfile> {
  const store = ownerDataOf(ctx);
  const values = await Promise.all(CAREER_FIELDS.map(async (field) => [field, (await store.get(field)) ?? ""] as const));
  return CareerProfile.parse(Object.fromEntries(values));
}

/**
 * 書き出した物を読む
 * @param store 拡張の置き場
 * @returns 書き出した物。無いか形が違えば空
 */
async function readShowcase(store: ExtensionStore): Promise<CareerShowcase> {
  return CareerShowcase.safeParse(await store.get("showcase")).data ?? NOTHING;
}

export default defineExtension({
  id: "career",
  title: "職務経歴",
  ownerData: true,
  routes: [
    { method: "get", path: "/profile", operationId: "getCareerProfile", summary: "職務経歴を開く", response: CareerProfile, run: readProfile },
    {
      method: "put",
      path: "/profile",
      operationId: "updateCareerProfile",
      summary: "職務経歴を置き換える",
      body: UpdateCareerProfileInput,
      response: CareerProfile,
      run: async (ctx, body: UpdateCareerProfileInput) => {
        const store = ownerDataOf(ctx);
        for (const field of CAREER_FIELDS) await store.put(field, body[field]);
        return body;
      },
    },
    { method: "get", path: "/showcase", operationId: "getCareerShowcase", summary: "人に見せるために書き出した項目を読む", response: CareerShowcase, run: (ctx) => readShowcase(ctx.store) },
    {
      method: "put",
      path: "/showcase",
      operationId: "updateCareerShowcase",
      summary: "人に見せる項目を選んで書き出す",
      body: UpdateCareerShowcaseInput,
      response: CareerShowcase,
      run: async (ctx, body: UpdateCareerShowcaseInput) => {
        // 選んだ項目だけを暗号を解いて置き場に写す。選ばない項目は書き出した物に入れない
        const store = ownerDataOf(ctx);
        const items: Record<string, string> = {};
        for (const field of body.fields) items[field] = (await store.get(field)) ?? "";
        const showcase: CareerShowcase = { items };
        await ctx.store.put("showcase", showcase);
        return showcase;
      },
    },
  ],
  tools: {
    showcase_read: { description: "オーナーが人に見せるために書き出した職務経歴の項目を読む。見せるサービスのリポジトリに置く時に使う", schema: ShowcaseReadTool, run: (ctx) => readShowcase(ctx.store) },
  },
});
