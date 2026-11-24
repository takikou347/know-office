// Zod の失敗を、problem+json の errors に入れる項目ごとの JSON Pointer と理由に直す (API の決まりの 4.3)
import type { FieldError } from "@know-office/core";
import type { ZodError } from "zod";

/** 入力の置き場所ごとの JSON Pointer の頭 */
const TARGET_PREFIX: Record<string, string> = { json: "#", query: "#/query", param: "#/path", header: "#/header", cookie: "#/cookie" };

/**
 * Zod の失敗を項目ごとの JSON Pointer と理由に直す
 * @param error Zod の失敗
 * @param target 入力の置き場所 (json、query、param など)
 * @returns 項目ごとの理由
 */
export function toFieldErrors(error: ZodError, target: string): FieldError[] {
  const prefix = TARGET_PREFIX[target] ?? "#";
  return error.issues.map((issue) => ({
    pointer: [prefix, ...issue.path.map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1"))].join("/"),
    detail: issue.message,
  }));
}
