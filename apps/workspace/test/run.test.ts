// タスク 1 件の SDK の呼び出しと、作業トークンを差し替えた時の続きからの呼び直しを確かめる (社員が考えるの 3.2)
import { describe, expect, it } from "vitest";
import type { Agent, AgentCall } from "../src/agent.ts";
import { Runner } from "../src/run.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const RUN = { nodeId: NODE, ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す" } as const;

/**
 * 呼ばれた SDK の呼び出しを並べ、止めるまで終わらない SDK の代わりを作る
 * @returns SDK の代わり、呼び出し、最後の呼び出しを終える口
 */
function fakeAgent() {
  const calls: AgentCall[] = [];
  const finishers: (() => void)[] = [];
  const agent: Agent = (call) => {
    calls.push(call);
    call.onSession("session-1");
    return new Promise((resolve, reject) => {
      finishers.push(() => resolve());
      call.options.abortController.signal.addEventListener("abort", () => reject(call.options.abortController.signal.reason));
    });
  };
  return { agent, calls, finish: () => finishers.at(-1)?.() };
}

/**
 * 待っている処理を先に進める
 */
async function settle(): Promise<void> {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
}

describe("1 時間を超えるタスク", () => {
  it("新しい作業トークンを受けたら、今の呼び出しを終えて続きから呼び直す", async () => {
    const { agent, calls, finish } = fakeAgent();
    const runner = new Runner(agent, () => {});
    runner.start(RUN);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.env.ANTHROPIC_API_KEY).toBe("ticket-1");
    expect(calls[0]?.options.resume).toBeUndefined();
    expect(runner.token()).toBe("ticket-1");

    runner.replaceTicket("ticket-2");
    // フックは次の判断から新しい作業トークンを使う
    expect(runner.token()).toBe("ticket-2");
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options.abortController.signal.aborted).toBe(true);
    expect(calls[1]?.options.env.ANTHROPIC_API_KEY).toBe("ticket-2");
    expect(calls[1]?.options.resume).toBe("session-1");
    expect(runner.running).toBe(true);

    finish();
    await settle();
    expect(runner.running).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("走っている間に次のタスクは受けない", async () => {
    const { agent } = fakeAgent();
    const runner = new Runner(agent, () => {});
    runner.start(RUN);
    expect(() => runner.start(RUN)).toThrow(/実行中/);
  });

  it("続きの session が分かる前に差し替えたら、session が分かった所で呼び直す", async () => {
    const calls: AgentCall[] = [];
    const runner = new Runner((call) => {
      calls.push(call);
      return new Promise((_resolve, reject) => {
        call.options.abortController.signal.addEventListener("abort", () => reject(call.options.abortController.signal.reason));
      });
    }, () => {});
    runner.start(RUN);
    runner.replaceTicket("ticket-2");
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.abortController.signal.aborted).toBe(false);
    calls[0]?.onSession("session-9");
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.resume).toBe("session-9");
    expect(calls[1]?.options.env.ANTHROPIC_API_KEY).toBe("ticket-2");
  });

  it("SDK の呼び出しが失敗したら、走っていない状態に戻して失敗を知らせる", async () => {
    const failures: unknown[] = [];
    const runner = new Runner(() => Promise.reject(new Error("落ちた")), (error) => failures.push(error));
    runner.start(RUN);
    await settle();
    expect(runner.running).toBe(false);
    expect(failures).toHaveLength(1);
  });
});
