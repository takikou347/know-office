// 開発の代わりの物 (Access、Claude API、GitHub) の宛先。ゲートウェイと同じ .dev.vars の DEV_FAKES_URL から読む
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect } from "@playwright/test";
import { z } from "zod";
import { parseDevVars } from "../../dev/plugin.ts";

/** 手元の代わりの物の宛先。作業ツリーごとにポートが違うので、決まった番号を書かない */
export const FAKES = `http://127.0.0.1:${parseDevVars(readFileSync(join(import.meta.dirname, "../../.dev.vars"), "utf8")).port}`;

const Keys = z.object({ keys: z.array(z.string()) });

/**
 * 代わりの Claude API が今通す鍵を読む
 * @param request Playwright の要求の口
 * @returns 通す鍵
 */
export async function claudeKeys(request: APIRequestContext): Promise<string[]> {
  return Keys.parse(await (await request.get(`${FAKES}/anthropic/__fake/keys`)).json()).keys;
}

/**
 * 代わりの Claude API が通す鍵を替える。空にすると、ゲートウェイの鍵を Anthropic の画面で消した時にあたる
 * @param request Playwright の要求の口
 * @param keys 通す鍵
 */
export async function setClaudeKeys(request: APIRequestContext, keys: string[]): Promise<void> {
  expect((await request.put(`${FAKES}/anthropic/__fake/keys`, { data: { keys } })).status()).toBe(204);
}

/**
 * 代わりの Claude API に鍵を足す。オーナーが Anthropic の画面で鍵を作ってから know-office に入れる事にあたる
 * @param request Playwright の要求の口
 * @param key 足す鍵
 */
export async function createClaudeKey(request: APIRequestContext, key: string): Promise<void> {
  await setClaudeKeys(request, [...(await claudeKeys(request)), key]);
}
