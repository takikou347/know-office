// 鍵の失敗らしい時の確かめが、作業トークンで count_tokens を呼び、ゲートウェイのプロキシの印で断った先を分ける事を確かめる (社員が考えるの 3.3)
import { describe, expect, it } from "vitest";
import { relayProbe } from "../src/sdk.ts";

describe("鍵の失敗の確かめ", () => {
  it("確かめは count_tokens を作業トークンで呼び、プロキシの印で分ける", async () => {
    const seen: string[] = [];
    const answer = (status: number, mark: string | null): typeof fetch => (url, init) => {
      seen.push(`${url instanceof Request ? url.url : url.toString()} ${new Headers(init?.headers).get("x-api-key") ?? ""}`);
      return Promise.resolve(new Response("{}", { status, headers: mark === null ? {} : { "x-know-relay": mark } }));
    };
    expect(await relayProbe("https://api.anthropic.com", answer(401, "refused"))("ticket-1", "claude-sonnet-5-5")).toBe("refused");
    expect(await relayProbe("https://api.anthropic.com", answer(401, "forwarded"))("ticket-1", "claude-sonnet-5-5")).toBe("upstream");
    expect(await relayProbe("https://api.anthropic.com", answer(200, "forwarded"))("ticket-1", "claude-sonnet-5-5")).toBe("unknown");
    expect(await relayProbe("https://api.anthropic.com", () => Promise.reject(new Error("届かない")))("ticket-1", "claude-sonnet-5-5")).toBe("unknown");
    expect(seen[0]).toBe("https://api.anthropic.com/v1/messages/count_tokens ticket-1");
  });
});
