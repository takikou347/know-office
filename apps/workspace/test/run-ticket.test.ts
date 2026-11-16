// 走りを終えた後の終わりの送りが、その間に差し替わった作業トークンを使う事を確かめる (社員が考えるの 3.3)
import type { RunInput } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { type Reporter, Runner } from "../src/run.ts";

const RUN: RunInput = { nodeId: "0190f4a8-0000-7000-8000-000000000101", ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す", tools: ["ask_boss"] };

/**
 * 待っている処理を先に進める
 */
async function settle(): Promise<void> {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
}

describe("終わりを送る間の作業トークンの差し替え", () => {
  it("走りを空けた後に届いた作業トークンも、終わりを送る口に渡る", async () => {
    const tickets: string[] = [];
    const box: { runner?: Runner } = {};
    const reporterOf: Reporter = {
      report: (ticket) => {
        box.runner?.replaceTicket("ticket-2");
        tickets.push(ticket());
        return Promise.resolve();
      },
    };
    const runner = new Runner(() => Promise.resolve("直した"), () => {}, undefined, undefined, reporterOf);
    box.runner = runner;
    runner.start(RUN);
    await settle();
    expect(tickets).toEqual(["ticket-2"]);
  });
});
