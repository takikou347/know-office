// ツールを使う前のフックが、ゲートウェイのルールの判断を聞き、答えが無ければ断る事を確かめる (社員が考えるの 3.4、4 章)
import type { Fetcher } from "@know-office/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentOptions, WORK_ROOT } from "../src/agent.ts";
import { DECISION_TIMEOUT_MS, GATE_DECISIONS_URL, preToolUse, type DeniedCall, type HookDeps } from "../src/hooks.ts";

/** 判断を聞いた中身 */
type Seen = { url: string; init: RequestInit | undefined };

/**
 * テスト用のフックの依り所を作る
 * @param fetcher ゲートウェイの代わり
 * @param record 断った記録を残す先。省くと並びに足す
 * @returns 依り所、聞いた中身、残った記録
 */
function setup(fetcher: Fetcher, record?: HookDeps["record"]) {
  const seen: Seen[] = [];
  const denied: DeniedCall[] = [];
  const deps: HookDeps = {
    fetcher: (url, init) => {
      seen.push({ url, init });
      return fetcher(url, init);
    },
    token: () => "ticket-1",
    clock: { now: () => 1_700_000_000_000 },
    record: record ?? ((call) => denied.push(call)),
  };
  return { hook: preToolUse(deps), seen, denied };
}

/**
 * ゲートウェイの成功の返事を作る
 * @param allow 通すか
 * @param reason 理由
 * @returns 返事
 */
function answer(allow: boolean, reason: string): Promise<Response> {
  return Promise.resolve(Response.json({ data: { allow, reason }, meta: { traceId: "t" } }));
}

// 答えず、signal も見ないゲートウェイ
const silent: Fetcher = () => new Promise(() => {});

// 4.9 秒で通す答えを返すゲートウェイ
const late: Fetcher = () => new Promise((resolve) => setTimeout(() => resolve(Response.json({ data: { allow: true, reason: "通す" }, meta: { traceId: "t" } })), 4900));

afterEach(() => {
  vi.useRealTimers();
});

const READ = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/work/a" } };

describe("鍵はゲートウェイだけが持つ", () => {
  it("ルールの判断が返らない", async () => {
    vi.useFakeTimers();
    const { hook, denied } = setup(silent);
    let settled = false;
    const pending = hook(READ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied).toEqual([{ at: 1_700_000_000_000, toolName: "Read", reason: out.hookSpecificOutput.permissionDecisionReason }]);
  });
});

describe("フックからルールの判断を聞く", () => {
  it("待つのは 5 秒", () => {
    expect(DECISION_TIMEOUT_MS).toBe(5000);
  });

  it("5 秒の内に返った答えは使う", async () => {
    vi.useFakeTimers();
    const { hook } = setup(late);
    const pending = hook(READ);
    await vi.advanceTimersByTimeAsync(4900);
    expect((await pending).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("記録を残せなくても断る", async () => {
    const { hook } = setup(
      () => Promise.reject(new TypeError("fetch failed")),
      () => {
        throw new Error("記録の先が落ちた");
      },
    );
    expect((await hook(READ)).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("作業トークンを付けてゲートウェイに聞き、通す答えなら通す", async () => {
    const { hook, seen, denied } = setup(() => answer(true, "/work の下"));
    const out = await hook(READ);
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "/work の下" });
    expect(seen[0]?.url).toBe(GATE_DECISIONS_URL);
    expect(seen[0]?.init?.method).toBe("POST");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer ticket-1");
    expect(JSON.parse(typeof seen[0]?.init?.body === "string" ? seen[0].init.body : "null")).toEqual({ toolName: "Read", toolInput: { file_path: "/work/a" } });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(denied).toEqual([]);
  });

  it("断る答えなら断り、記録はゲートウェイに任せる", async () => {
    const { hook, denied } = setup(() => answer(false, "main への push"));
    const out = await hook({ ...READ, tool_name: "Bash", tool_input: { command: "git push origin main" } });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("main への push");
    expect(denied).toEqual([]);
  });

  it.each([
    ["届かない", () => Promise.reject(new TypeError("fetch failed"))],
    ["止まっていて 409", () => Promise.resolve(Response.json({ code: "stopped" }, { status: 409 }))],
    ["エラーの 500", () => Promise.resolve(new Response("", { status: 500 }))],
    ["形の違う返事", () => Promise.resolve(Response.json({ data: { allow: "yes" }, meta: { traceId: "t" } }))],
    ["JSON でない返事", () => Promise.resolve(new Response("<html>"))],
  ] satisfies [string, Fetcher][])("%s時は断り、断った記録を残す", async (_name, fetcher) => {
    const { hook, denied } = setup(fetcher);
    const out = await hook(READ);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.toolName).toBe("Read");
  });

  it("形の違うフックの入力は聞かずに断る", async () => {
    const { hook, seen, denied } = setup(() => answer(true, "通す"));
    const out = await hook({ tool_input: {} });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(seen).toEqual([]);
    expect(denied).toHaveLength(1);
  });
});

describe("ワークスペースを分ける", () => {
  it("フックを書き換えられない", () => {
    const { hook } = setup(() => answer(true, "通す"));
    const options = agentOptions({ ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", hook, abortController: new AbortController() });
    // リポジトリの中の .claude/ の設定と、利用者の設定を読まない。フックは関数で渡し、ファイルから読まない
    expect(options.settingSources).toEqual([]);
    expect(options.hooks).toEqual({ PreToolUse: [{ hooks: [hook] }] });
    expect(options.cwd).toBe(WORK_ROOT);
    // SDK に渡す環境変数は、作業トークンと動くのに要る物だけ。ワークスペースの環境変数をそのまま渡さない
    expect(Object.keys(options.env).toSorted()).toEqual(["ANTHROPIC_API_KEY", "HOME", "NODE_EXTRA_CA_CERTS", "PATH"]);
    expect(options.env.ANTHROPIC_API_KEY).toBe("ticket-1");
  });
});
