// 管理の拡張の返す形と入力、拡張とツールの名前の形 (サービスと拡張の 3.8)
import { z } from "./zod.ts";

/** 拡張の ID。小文字の kebab-case で、ルートの `/api/v1/ext/<id>` と R2 の `ext/<id>/` に使う */
export const EXTENSION_ID = /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/;

/** 拡張のツールの名前。小文字の snake_case で、`__` を含まない */
export const EXTENSION_TOOL = /^[a-z][a-z\d]*(?:_[a-z\d]+)*$/;

/** 拡張の 1 件。enabled は設定で入れているか、ownerData はオーナーの情報を扱うか */
export const Extension = z
  .object({
    id: z.string(),
    title: z.string(),
    enabled: z.boolean(),
    ownerData: z.boolean(),
  })
  .strict()
  .meta({ id: "Extension" });

/** 拡張の 1 件の型 */
export type Extension = z.infer<typeof Extension>;

/** 拡張を入れるか切る入力 */
export const ToggleExtensionInput = z.object({ enabled: z.boolean() }).strict().meta({ id: "ToggleExtensionInput" });

/** 拡張を入れるか切る入力の型 */
export type ToggleExtensionInput = z.infer<typeof ToggleExtensionInput>;
