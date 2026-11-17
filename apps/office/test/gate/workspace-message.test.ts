// 走っている呼び出しにオーナーの発言を足させる口。止まったコンテナを起こさず、409 と届かない時を分ける (社員が考えるの 3.9)
import { AppError } from "@know-office/core";
import { describe, expect, it } from "vitest";
import type { Caller } from "../../src/gate/egress.ts";
import { type ContainerLike, WorkspaceBox } from "../../src/gate/work/workspace-box.ts";

const CALLER: Caller = { staffId: "builder", workspaceId: "ws-builder" };
const INPUT = { body: "テストも足して", at: "2026-11-17T01:05:00.000Z" };

/**
 * /v1/messages の答え方を決めた、代わりのコンテナを作る
 * @param answer 発言への答え。数ならそのステータス、timeout なら待ちが切れる
 * @param running 初めから動いているか
 * @returns コンテナと、届いた道と本文
 */
function container(answer: number | "timeout", running: boolean) {
  const seen: { url: string; body: unknown; signal: boolean }[] = [];
  let up = running;
  const like: ContainerLike<null> = {
    get running() {
      return up;
    },
    intercepts: false,
    start: () => {
      up = true;
    },
    interceptOutboundHttp: () => Promise.resolve(),
    interceptOutboundHttps: () => Promise.resolve(),
    getTcpPort: () => ({
      fetch: (url, init) => {
        seen.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, signal: init?.signal instanceof AbortSignal });
        if (url.endsWith("/v1/health")) return Promise.resolve(Response.json({ data: { ok: true, part: "workspace" }, meta: { traceId: "t" } }));
        if (answer === "timeout") return Promise.reject(new DOMException("待ちが切れた", "TimeoutError"));
        return Promise.resolve(new Response(null, { status: answer }));
      },
    }),
    destroy: () => {
      up = false;
      return Promise.resolve();
    },
  };
  return { like, seen };
}

/**
 * 鍵を持った箱を作る
 * @param like コンテナ
 * @param key 記憶にある鍵。null は無い
 * @returns WorkspaceBox と起こした回数
 */
function box(like: ContainerLike<null>, key: string | null = "k".repeat(64)) {
  const boots = { n: 0 };
  const made = new WorkspaceBox(like, () => null, CALLER, {
    wait: () => Promise.resolve(),
    keys: { get: () => Promise.resolve(key ?? undefined), put: () => Promise.resolve(void (boots.n += 1)) },
    notifyDown: () => Promise.reject(new Error("知らせない")),
  });
  return { made, boots };
}

describe("オーナーの発言を足す口", () => {
  it("動いているコンテナが 204 を返せば受けた事にし、本文と時刻を送る", async () => {
    const { like, seen } = container(204, true);
    expect(await box(like).made.message(INPUT)).toBe(true);
    expect(seen).toEqual([{ url: "http://workspace/v1/messages", body: INPUT, signal: true }]);
  });

  it("止まったコンテナと鍵の無いコンテナは起こさず、何も送らずに false を返す", async () => {
    const stopped = container(204, false);
    const a = box(stopped.like);
    expect(await a.made.message(INPUT)).toBe(false);
    expect(stopped.like.running).toBe(false);
    expect(stopped.seen).toEqual([]);
    const keyless = container(204, true);
    const b = box(keyless.like, null);
    expect(await b.made.message(INPUT)).toBe(false);
    expect(b.boots.n).toBe(0);
    expect(keyless.seen).toEqual([]);
  });

  it("走っていない (409) 時は false、ほかのステータスと待ちが切れた時は unavailable を投げる", async () => {
    expect(await box(container(409, true).like).made.message(INPUT)).toBe(false);
    await expect(box(container(500, true).like).made.message(INPUT)).rejects.toMatchObject({ code: "unavailable" });
    await expect(box(container("timeout", true).like).made.message(INPUT)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("形の違う発言は送らずに断る", async () => {
    const { like, seen } = container(204, true);
    await expect(box(like).made.message({ body: "", at: INPUT.at })).rejects.toBeInstanceOf(AppError);
    await expect(box(like).made.message({ body: "x" })).rejects.toMatchObject({ code: "validation_failed" });
    expect(seen).toEqual([]);
  });
});
