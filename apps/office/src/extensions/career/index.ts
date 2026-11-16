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
  const values = await ownerDataOf(ctx).get(CAREER_FIELDS);
  return CareerProfile.parse(Object.fromEntries(CAREER_FIELDS.map((field) => [field, values[field] ?? ""])));
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
    { method: "get", path: "/profile", operationId: "getCareerProfile", summary: "職務経歴を開く", steps: ["`owner_data` の `career` の項目ごとに `deriveKey(MASTER_KEY, \"owner-data\")` で暗号を解き、置いていない項目は空の文にする", "戻せた項目ごとに `owner_data_reads` に `by: owner` で 1 行足す"], response: CareerProfile, run: readProfile },
    {
      method: "put",
      path: "/profile",
      operationId: "updateCareerProfile",
      summary: "職務経歴を置き換える",
      steps: ["項目ごとに暗号にし、全部の項目の前の行を消して足すのを 1 回のバッチで書く", "監査ログに `extension.write` を記録する"],
      body: UpdateCareerProfileInput,
      response: CareerProfile,
      run: async (ctx, body: UpdateCareerProfileInput) => {
        await ownerDataOf(ctx).put(body);
        return body;
      },
    },
    { method: "get", path: "/showcase", operationId: "getCareerShowcase", summary: "人に見せるために書き出した項目を読む", steps: ["R2 の `ext/career/showcase.json` を読む。無ければ空を返す"], response: CareerShowcase, run: (ctx) => readShowcase(ctx.store) },
    {
      method: "put",
      path: "/showcase",
      operationId: "updateCareerShowcase",
      summary: "人に見せる項目を選んで書き出す",
      steps: ["選んだ項目だけの暗号を解き (`owner_data_reads` に `by: owner` で残す)、R2 の `ext/career/showcase.json` を置き換える。選ばない項目は入れない", "監査ログに `extension.write` を記録する"],
      body: UpdateCareerShowcaseInput,
      response: CareerShowcase,
      run: async (ctx, body: UpdateCareerShowcaseInput) => {
        // 選んだ項目だけを暗号を解いて置き場に写す。選ばない項目は書き出した物に入れない
        const values = await ownerDataOf(ctx).get(body.fields);
        const showcase: CareerShowcase = { items: Object.fromEntries(body.fields.map((field) => [field, values[field] ?? ""])) };
        await ctx.store.put("showcase", showcase);
        return showcase;
      },
    },
  ],
  tools: {
    showcase_read: { description: "オーナーが人に見せるために書き出した職務経歴の項目を読む。見せるサービスのリポジトリに置く時に使う", schema: ShowcaseReadTool, run: (ctx) => readShowcase(ctx.store) },
  },
});
