// タスク 1 件の SDK の呼び出しと、作業トークンを差し替えた時の続きからの呼び直しを確かめる (社員が考えるの 3.3)
import type { AgentEvent, RunInput } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentCall } from "../src/agent.ts";
import { type Reporter, Runner } from "../src/run.ts";
import { SdkFailure } from "../src/sdk.ts";

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

/**
 * ゲートウェイに送った出来事を控える口を作る
 * @param runner 送った時に走っていたかを見る呼び出し。後から入れる
 * @returns 送り先と送った物
 */
function reporter() {
  const sent: { ticket: string; events: AgentEvent[]; running: boolean }[] = [];
  const box: { runner?: Runner } = {};
  const reporterOf: Reporter = {
    report: (ticket, events) => {
      sent.push({ ticket: ticket(), events, running: box.runner?.running ?? false });
      return Promise.resolve();
    },
  };
  return { reporterOf, sent, box };
}

/**
 * 会話の記録を送った時を控える口を作る
 * @returns 送った物と口
 */
function flushes() {
  const flushed: string[] = [];
  const transcripts = { flush: (sessionId: string, ticket: string) => Promise.resolve(void flushed.push(`${sessionId} ${ticket}`)), restore: () => Promise.resolve() };
  return { flushed, transcripts };
}

describe("働いた事をゲートウェイに届ける", () => {
  it("呼び出しが終わったら、走りを空けてから最後の文と終わりを送る", async () => {
    const { reporterOf, sent, box } = reporter();
    const runner = new Runner(
      (call) => {
        call.onSession("session-1");
        return Promise.resolve("直した");
      },
      () => {},
      undefined,
      undefined,
      reporterOf,
    );
    box.runner = runner;
    runner.start(RUN);
    await settle();
    expect(sent).toEqual([
      {
        ticket: "ticket-1",
        running: false,
        events: [
          { kind: "message", body: "直した" },
          { kind: "result", nodeId: NODE, result: "done" },
        ],
      },
    ]);
  });

  it("SDK が失敗したら、走りを空けてからエラーと handed_back を送り、SDK の文は送らない", async () => {
    const { reporterOf, sent, box } = reporter();
    const runner = new Runner(() => Promise.reject(new SdkFailure("sdk_auth_failed", "Claude API が 401 で断った")), () => {}, undefined, undefined, reporterOf);
    box.runner = runner;
    runner.start(RUN);
    await settle();
    expect(sent).toEqual([
      {
        ticket: "ticket-1",
        running: false,
        events: [
          { kind: "error", name: "sdk_auth_failed", message: "Claude API が 401 で断った" },
          { kind: "result", nodeId: NODE, result: "handed_back" },
        ],
      },
    ]);
    const other = reporter();
    const failing = new Runner(() => Promise.reject(new Error("sk-ant-secret が漏れた")), () => {}, undefined, undefined, other.reporterOf);
    failing.start(RUN);
    await settle();
    expect(other.sent[0]?.events[0]).toEqual({ kind: "error", name: "sdk_failed", message: "SDK の呼び出しが失敗した" });
  });

  it("止めると、記録を送ってから止め、終わりもエラーも送らない", async () => {
    const { agent, calls } = fakeAgent();
    const { reporterOf, sent } = reporter();
    const { flushed, transcripts } = flushes();
    const runner = new Runner(agent, () => {}, undefined, transcripts, reporterOf);
    runner.start(RUN);
    await settle();
    await runner.abort("wrap_up");
    expect(calls[0]?.options.abortController.signal.aborted).toBe(true);
    expect(flushed).toEqual(["session-1 ticket-1"]);
    expect(runner.running).toBe(false);
    expect(sent).toEqual([]);
    // 走っていない時は何もしない
    await runner.abort("wrap_up");
  });

  it("SDK が終えた直後に止めても、終わりは送る", async () => {
    const { reporterOf, sent } = reporter();
    // 終えた後の記録の送りの間に止めが届く
    const gate: { open?: () => void } = {};
    const transcripts = { flush: () => new Promise<void>((resolve) => (gate.open = resolve)), restore: () => Promise.resolve() };
    const runner = new Runner(
      (call) => {
        call.onSession("session-1");
        return Promise.resolve("直した");
      },
      () => {},
      undefined,
      transcripts,
      reporterOf,
    );
    runner.start(RUN);
    await settle();
    const aborted = runner.abort("wrap_up");
    gate.open?.();
    await aborted;
    expect(sent.map((s) => s.events.at(-1))).toEqual([{ kind: "result", nodeId: NODE, result: "done" }]);
  });

  it("オーナーの発言は、記録を送ってから今の呼び出しを止め、発言を指示に続きから 1 回だけ呼び、止めた呼び出しの終わりは送らない", async () => {
    const { agent, calls, finish } = fakeAgent();
    const { reporterOf, sent } = reporter();
    const { flushed, transcripts } = flushes();
    const runner = new Runner(agent, () => {}, undefined, transcripts, reporterOf);
    runner.start(RUN);
    await settle();
    await runner.addMessage("テストも足して");
    await settle();
    expect(flushed[0]).toBe("session-1 ticket-1");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options.abortController.signal.aborted).toBe(true);
    expect(calls[1]?.prompt).toContain("テストも足して");
    expect(calls[1]?.options.resume).toBe("session-1");
    expect(sent).toEqual([]);
    finish();
    await settle();
    expect(sent.map((s) => s.events.map((e) => e.kind))).toEqual([["result"]]);
  });

  it("同時の 2 つの発言は、1 回の続きにまとめる", async () => {
    const { agent, calls } = fakeAgent();
    const runner = new Runner(agent, () => {});
    runner.start(RUN);
    await settle();
    await Promise.all([runner.addMessage("1 つ目"), runner.addMessage("2 つ目")]);
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("1 つ目");
    expect(calls[1]?.prompt).toContain("2 つ目");
  });

  it("走っていない時の発言は conflict で断る", async () => {
    const runner = new Runner(() => Promise.resolve(), () => {});
    await expect(runner.addMessage("聞こえる?")).rejects.toMatchObject({ code: "conflict" });
  });
});
