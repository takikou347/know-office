// 型の食い違いが型の検査で落ちる事を確かめる。@ts-expect-error の行が通るようになると、tsc が落ちる
import type { Health } from "../src/index.ts";

export const fine: Health = { ok: true, part: "gate" };

// @ts-expect-error 無い部分の名前は入らない
export const wrongPart: Health = { ok: true, part: "screen" };

// @ts-expect-error ok は true だけ
export const wrongOk: Health = { ok: false, part: "gate" };
