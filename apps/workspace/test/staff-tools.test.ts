// 社員のツールの MCP の受け手が、役のツールだけを出し、ゲートウェイの POST /ws/v1/tools/{toolName} を呼ぶだけである事を確かめる (社員が考えるの 3.5)
import type { Fetcher } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { GATE_TOOLS_URL, staffServer, staffToolDefinitions, type StaffToolDeps } from "../src/staff-tools.ts";

/** ゲートウェイが受けた呼び出し */
type Seen = { url: string; authorization: string | null; body: unknown };

/**
 * ゲートウェイの代わりを作る。受けた呼び出しを並べ、決めた返事を返す
 * @param reply 返す返事
 * @returns fetch の代わりと受けた呼び出し
 */
function gateway(reply: () => Response): { fetcher: Fetcher; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher: Fetcher = (url, init) => {
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(typeof init?.body === "string" ? init.body : "null") });
    return Promise.resolve(reply());
  };
  return { fetcher, seen };
}

/**
 * 名前のツールを動かす
 * @param deps 受け手の依り所
 * @param name ツールの名前
 * @param args 入力
 * @returns ツールの答え
 */
async function invoke(deps: StaffToolDeps, name: string, args: Record<string, unknown>) {
  const found = staffToolDefinitions(deps, ["ask_boss", "ask_owner"]).find((t) => t.name === name);
  if (!found) throw new Error(`${name} が無い`);
  return found.handler(args, {});
}

/**
 * ゲートウェイの成功の返事を作る
 * @returns 成功の返事
 */
const OK = () => Response.json({ data: { content: JSON.stringify({ id: "plan-1" }), isError: false }, meta: { traceId: "t" } });

/**
 * ゲートウェイの断りの返事を作る
 * @returns 409 の problem+json
 */
const conflict = () =>
  Response.json({ type: "about:blank", title: "Conflict", status: 409, detail: "今のタスクが無い", code: "conflict", traceId: "t" }, { status: 409, headers: { "content-type": "application/problem+json" } });

/**
 * 形の違う返事を作る
 * @returns JSON でない 200
 */
const notJson = () => new Response("<html>", { status: 200 });

describe("社員のツールの MCP の受け手", () => {
  it("役のツールだけを、受け手 staff に説明と入力の形を付けて出す", () => {
    const deps: StaffToolDeps = { fetcher: gateway(OK).fetcher, token: () => "ticket-1" };
    const tools = staffToolDefinitions(deps, ["pr_open", "ask_boss"]);
    expect(tools.map((t) => t.name)).toEqual(["pr_open", "ask_boss"]);
    expect(Object.keys(tools[0]?.inputSchema ?? {}).toSorted()).toEqual(["body", "name", "title"]);
    expect(tools.every((t) => t.description !== "")).toBe(true);
    const server = staffServer(deps, ["ask_boss"]);
    expect(server).toMatchObject({ type: "sdk", name: "staff" });
  });

  it("呼ぶと作業トークンを付けてゲートウェイに入力を送り、答えの content を返す", async () => {
    const gate = gateway(OK);
    const result = await invoke({ fetcher: gate.fetcher, token: () => "ticket-1" }, "ask_boss", { reason: "次は" });
    expect(gate.seen).toEqual([{ url: `${GATE_TOOLS_URL}ask_boss`, authorization: "Bearer ticket-1", body: { toolInput: { reason: "次は" } } }]);
    expect(GATE_TOOLS_URL).toBe("http://gate.internal/ws/v1/tools/");
    expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: "plan-1" }) }], isError: false });
  });

  it("作業トークンを差し替えた後は、新しい作業トークンで呼ぶ", async () => {
    const gate = gateway(OK);
    let ticket = "ticket-1";
    const deps: StaffToolDeps = { fetcher: gate.fetcher, token: () => ticket };
    await invoke(deps, "ask_boss", { reason: "次は" });
    ticket = "ticket-2";
    await invoke(deps, "ask_boss", { reason: "次は" });
    expect(gate.seen.map((s) => s.authorization)).toEqual(["Bearer ticket-1", "Bearer ticket-2"]);
  });

  it("ゲートウェイが断った時は、code と detail を isError で返す", async () => {
    const result = await invoke({ fetcher: gateway(conflict).fetcher, token: () => "ticket-1" }, "ask_owner", { kind: "cost_increase", target: "x", reason: "y" });
    expect(result).toEqual({ content: [{ type: "text", text: "conflict: 今のタスクが無い" }], isError: true });
  });

  it("形の違う返事は、中身を渡さずに isError で返す", async () => {
    const result = await invoke({ fetcher: gateway(notJson).fetcher, token: () => "ticket-1" }, "ask_boss", { reason: "次は" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("html");
  });

  it("決めた時間で答えが無ければ、送り直さずに結果が分からない事を isError で返す", async () => {
    let calls = 0;
    const hanging: Fetcher = (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    };
    const result = await invoke({ fetcher: hanging, token: () => "ticket-1", timeoutMs: 20 }, "ask_boss", { reason: "次は" });
    expect(calls).toBe(1);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("結果が分からない");
  });

  it("checkpoint のツールが通った時だけ、会話の記録を送らせる", async () => {
    let flushed = 0;
    const run = async (reply: () => Response) => {
      const deps: StaffToolDeps = { fetcher: gateway(reply).fetcher, token: () => "ticket-1", onCheckpoint: () => void (flushed += 1) };
      const found = staffToolDefinitions(deps, ["checkpoint", "report"]);
      await found.find((t) => t.name === "checkpoint")?.handler({ kind: "commit" }, {});
      await found.find((t) => t.name === "report")?.handler({ body: "進んだ" }, {});
    };
    await run(OK);
    expect(flushed).toBe(1);
    await run(conflict);
    expect(flushed).toBe(1);
  });
});
