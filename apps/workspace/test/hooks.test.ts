// ツールを使う前のフックが、ゲートウェイのルールの判断を聞き、答えが無ければ断る事を確かめる (社員が考えるの 3.4、4 章)
import type { Fetcher } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { DECISION_TIMEOUT_MS, GATE_DECISIONS_URL, preToolUse, type DeniedCall, type HookDeps } from "../src/hooks.ts";

/** 判断を聞いた中身 */
type Seen = { url: string; init: RequestInit | undefined };

/**
 * テスト用のフックの依り所を作る
 * @param fetcher ゲートウェイの代わり
 * @param deadline 待ちの期限の作り方
 * @returns 依り所、聞いた中身、残った記録
 */
function setup(fetcher: Fetcher, deadline?: (ms: number) => AbortSignal) {
  const seen: Seen[] = [];
  const denied: DeniedCall[] = [];
  const deps: HookDeps = {
    fetcher: (url, init) => {
      seen.push({ url, init });
      return fetcher(url, init);
    },
    token: () => "ticket-1",
    clock: { now: () => 1_700_000_000_000 },
    record: (call) => denied.push(call),
    ...(deadline ? { deadline } : {}),
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

// 答えないゲートウェイ。期限が来ると fetch と同じく中断で失敗する
const silent: Fetcher = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
  });

const READ = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/work/a" } };

describe("鍵はゲートウェイだけが持つ", () => {
  it("ルールの判断が返らない", async () => {
    let asked = 0;
    const controller = new AbortController();
    const { hook, denied } = setup(silent, (ms) => {
      asked = ms;
      return controller.signal;
    });
    const pending = hook(READ);
    controller.abort();
    const out = await pending;
    expect(asked).toBe(5000);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied).toEqual([{ at: 1_700_000_000_000, toolName: "Read", reason: out.hookSpecificOutput.permissionDecisionReason }]);
  });
});

describe("フックからルールの判断を聞く", () => {
  it("待つのは 5 秒", () => {
    expect(DECISION_TIMEOUT_MS).toBe(5000);
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
