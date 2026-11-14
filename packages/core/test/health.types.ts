// 型の食い違いが型の検査で落ちる事を確かめる。@ts-expect-error の行が通るようになると、tsc が落ちる
import type { ErrorCode, Health } from "../src/index.ts";

export const fine: Health = { ok: true, part: "gate" };

// @ts-expect-error 無い部分の名前は入らない
export const wrongPart: Health = { ok: true, part: "db" };

// @ts-expect-error 無い code は入らない
export const wrongCode: ErrorCode = "teapot";
