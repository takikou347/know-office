// 画面とゲートウェイの食い違いが型の検査で落ちる事を確かめる。@ts-expect-error の行が通るようになると、tsc が落ちる
import type { Health } from "@know-office/core";
import { createApi } from "../src/screen/api.ts";

const api = createApi("http://localhost");

export async function fine(): Promise<Health> {
  const res = await api.api.v1.health.$get();
  if (res.status === 200) return (await res.json()).data;
  throw new Error("稼働確認に失敗した");
}

export async function wrongShape(): Promise<{ ok: true; part: "db" }> {
  const res = await api.api.v1.health.$get();
  if (res.status === 200) {
    // @ts-expect-error ゲートウェイが返す形と違う形では受け取れない
    return (await res.json()).data;
  }
  throw new Error("稼働確認に失敗した");
}

// @ts-expect-error ゲートウェイに無いルートは呼べない
export const noRoute = api.api.v1.nothing;
