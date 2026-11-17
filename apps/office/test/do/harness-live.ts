// DO のテストの入口の手伝い。配信 DO への呼び出しを形で確かめて渡す物と、エディタの補完を持たないワークスペースの DO の土台
import { DurableObject } from "cloudflare:workers";
import { AppError } from "@know-office/core";
import { z } from "zod";
import type { Bindings } from "../../src/gate/env.ts";
import type { LspPrepared } from "../../src/gate/work/editor-lsp.ts";

/** 配信 DO への呼び出し */
const LiveCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("issue"), args: z.tuple([z.number()]) }),
  z.object({ method: z.literal("redeem"), args: z.tuple([z.string(), z.number()]) }),
  z.object({ method: z.literal("publish"), args: z.tuple([z.unknown()]) }),
  z.object({ method: z.literal("closeSession"), args: z.tuple([z.string()]) }),
  z.object({ method: z.literal("closeAll"), args: z.tuple([z.string().nullable()]) }),
  z.object({ method: z.enum(["holdLsp", "releaseLsp"]), args: z.tuple([z.string(), z.number()]) }),
]);

/**
 * 配信 DO のメソッドを、形を確かめてから呼ぶ
 * @param live 配信 DO
 * @param body テストが送った呼び出し
 * @returns 答え
 */
export async function callLive(live: ReturnType<Bindings["LIVE"]["get"]>, body: unknown): Promise<unknown> {
  const call = LiveCall.parse(body);
  if (call.method === "issue") return live.issue(call.args[0]);
  if (call.method === "redeem") return live.redeem(call.args[0], call.args[1]);
  if (call.method === "publish") return live.publish(call.args[0]);
  if (call.method === "closeSession") return live.closeSession(call.args[0]);
  if (call.method === "closeAll") return live.closeAll(call.args[0]);
  return live[call.method](call.args[0], call.args[1]);
}

/** エディタの補完を持たないワークスペースの DO の土台。テストの入口はコンテナを起こさないので、いつも動いていない。社員 DO の arm が毎回呼ぶ物もあるので、呼び出しを並べない */
export class IdleLsp extends DurableObject<Bindings> {
  /**
   * 補完の支度。動いていないので断る
   * @returns 返らない
   */
  lspPrepare(): Promise<LspPrepared> {
    return Promise.reject(new AppError("unavailable", "ワークスペースが動いていない"));
  }

  /**
   * 木を渡す。受けない
   * @returns 無し
   */
  lspPutTree(): Promise<null> {
    return Promise.resolve(null);
  }

  /**
   * 木を取れなかった
   * @returns 無し
   */
  lspDropTree(): Promise<null> {
    return Promise.resolve(null);
  }

  /**
   * 補完の接続を閉じる。開いている物は無い
   * @returns 無し
   */
  closeLsp(): Promise<null> {
    return Promise.resolve(null);
  }

  /**
   * 補完で起こした物を確かめる。起こさないので何もしない
   * @returns 無し
   */
  sweepEditor(): Promise<null> {
    return Promise.resolve(null);
  }
}
