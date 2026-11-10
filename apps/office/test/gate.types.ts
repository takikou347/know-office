// 画面と入口の食い違いが型の検査で落ちる事を確かめる。@ts-expect-error の行が通るようになると、tsc が落ちる
import type { Health } from "@know-office/core";
import { Hono } from "hono";
import { createApi } from "../src/screen/api.ts";

const api = createApi("http://localhost");

export async function fine(): Promise<Health> {
  const res = await api.api.health.$get();
  return res.json();
}

export async function wrongShape(): Promise<{ ok: true; part: "screen" }> {
  const res = await api.api.health.$get();
  // @ts-expect-error 入口が返す形と違う形では受け取れない
  return res.json();
}

// @ts-expect-error 入口に無い道は呼べない
export const noRoute = api.api.nothing;

// @ts-expect-error 入口は Health と違う形を返せない
export const wrongGate = new Hono().get("/api/health", (c) => c.json<Health>({ ok: true, part: "screen" }));
