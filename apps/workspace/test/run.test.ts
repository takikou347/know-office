// タスク 1 件の SDK の呼び出しと、作業トークンを差し替えた時の続きからの呼び直しを確かめる (社員が考えるの 3.2)
import type { RunInput } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentCall } from "../src/agent.ts";
import { Runner } from "../src/run.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const RUN: RunInput = { nodeId: NODE, ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す", tools: ["ask_boss"] };

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
    // 社員のツールの受け手は、呼び直すたびに作り直す
    expect(calls[0]?.options.mcpServers.staff).toMatchObject({ type: "sdk", name: "staff" });

    runner.replaceTicket("ticket-2");
    // フックは次の判断から新しい作業トークンを使う
    expect(runner.token()).toBe("ticket-2");
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options.abortController.signal.aborted).toBe(true);
    expect(calls[1]?.options.env.ANTHROPIC_API_KEY).toBe("ticket-2");
    expect(calls[1]?.options.resume).toBe("session-1");
    expect(calls[1]?.options.mcpServers.staff).not.toBe(calls[0]?.options.mcpServers.staff);
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

  it("呼び直す前と終わった時に、会話の記録の増えをその時の作業トークンで送る", async () => {
    const { agent, finish } = fakeAgent();
    const flushed: [string, string][] = [];
    const runner = new Runner(agent, () => {}, undefined, {
      flush: (sessionId, ticket) => Promise.resolve(void flushed.push([sessionId, ticket])),
      restore: () => Promise.resolve(),
    });
    runner.start(RUN);
    await settle();
    expect(flushed).toEqual([]);
    runner.replaceTicket("ticket-2");
    await settle();
    expect(flushed).toEqual([["session-1", "ticket-2"]]);
    finish();
    await settle();
    expect(flushed).toEqual([
      ["session-1", "ticket-2"],
      ["session-1", "ticket-2"],
    ]);
  });

  it("SDK の出来事を読む間、前に送ってから 60 秒過ぎていれば、待たず重ねずに会話の記録の増えを送る", async () => {
    let now = 0;
    const calls: AgentCall[] = [];
    const agent: Agent = (call) => {
      calls.push(call);
      call.onSession("session-1");
      return new Promise(() => {});
    };
    const flushed: number[] = [];
    const pending: (() => void)[] = [];
    const runner = new Runner(
      agent,
      () => {},
      { fetcher: () => Promise.reject(new Error("呼ばない")), clock: { now: () => now }, record: () => {} },
      {
        flush: () => {
          flushed.push(now);
          return new Promise<void>((resolve) => pending.push(resolve));
        },
        restore: () => Promise.resolve(),
      },
    );
    runner.start(RUN);
    await settle();
    const event = () => calls[0]?.onEvent();
    now = 30_000;
    event();
    expect(flushed).toEqual([]);
    now = 60_000;
    event();
    expect(flushed).toEqual([60_000]);
    // 送っている間は重ねない
    now = 125_000;
    event();
    expect(flushed).toEqual([60_000]);
    pending.shift()?.();
    await settle();
    now = 126_000;
    event();
    expect(flushed).toEqual([60_000, 126_000]);
    now = 150_000;
    event();
    expect(flushed).toEqual([60_000, 126_000]);
  });

  it("会話の記録を送れなくても、呼び出しは止めずに記録を残す", async () => {
    const { agent, finish } = fakeAgent();
    const failures: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = new Runner(agent, (error) => failures.push(error), undefined, { flush: () => Promise.reject(new Error("届かない")), restore: () => Promise.resolve() });
    runner.start(RUN);
    await settle();
    runner.replaceTicket("ticket-2");
    await settle();
    finish();
    await settle();
    const lines = warn.mock.calls.map(([line]) => String(line));
    warn.mockRestore();
    expect(failures).toEqual([]);
    expect(runner.running).toBe(false);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: "warn", event: "transcript_send_failed", error: "届かない" },
      { level: "warn", event: "transcript_send_failed", error: "届かない" },
    ]);
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
