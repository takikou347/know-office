// D1 の置き場ごとの使った量の返す形 (ログインと記録の 3.5)
import { z } from "./zod.ts";

/** 置き場ごとの使った量と、上限 10GB に対する割合 */
export const StorageUse = z.object({ binding: z.string(), bytes: z.number().int(), ratio: z.number().min(0).max(1) }).strict().meta({ id: "StorageUse" });

/** 置き場ごとの使った量の型 */
export type StorageUse = z.infer<typeof StorageUse>;
