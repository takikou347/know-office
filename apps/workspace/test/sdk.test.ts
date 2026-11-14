// ワークスペースが Claude Agent SDK を、設定を読ませず、作業トークンを鍵に、フックを関数で渡して呼ぶ事を確かめる (社員が考えるの 3.1、3.2)
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "@know-office/core";
import { afterEach, describe, expect, it } from "vitest";
import { agentOptions, type AgentCall } from "../src/agent.ts";
import { preToolUse } from "../src/hooks.ts";
import { type QueryFn, sdkAgent, sdkOptions } from "../src/sdk.ts";

/** 代わりの Claude API に積む返事。text か tool_use のブロック */
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** 代わりの Claude API が受けた要求 */
type Received = { path: string; key: string | undefined; body: Record<string, unknown> };

/**
 * 項目を持つ物かを確かめる
 * @param value 値
 * @returns 項目を持つ物なら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SDK が失敗で終える代わり
 * @yields 失敗の result
 */
const failing: QueryFn = async function* () {
  yield { type: "result", subtype: "error_during_execution", session_id: "session-1" };
};

/** 開いた物。テストの後に閉じて消す */
const opened: { servers: Server[]; dirs: string[] } = { servers: [], dirs: [] };

afterEach(() => {
  for (const server of opened.servers.splice(0)) server.close();
  for (const dir of opened.dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 積んだ返事を Messages API の流れの形で順に返す、代わりの Claude API を手元に立てる
 * @param replies 返事の並び。1 回の呼び出しに 1 つ
 * @returns 宛先と受けた要求
 */
async function fakeClaude(replies: Block[][]): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/messages")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      const body = isRecord(parsed) ? parsed : {};
      const key = req.headers["x-api-key"];
      received.push({ path: req.url ?? "", key: typeof key === "string" ? key : undefined, body });
      // 積んだ返事が尽きたら、終わりの文を返す。SDK が裏で呼ぶ軽い呼び出しもここに来る
      const content = replies.shift() ?? [{ type: "text", text: "終わった" }];
      const stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      const message = { id: `msg_${String(received.length)}`, type: "message", role: "assistant", model: body["model"], content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", { message });
      for (const [index, block] of content.entries()) {
        if (block.type === "text") {
          send("content_block_start", { index, content_block: { type: "text", text: "" } });
          send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
        } else {
          send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
          send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        }
        send("content_block_stop", { index });
      }
      send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
      send("message_stop", {});
      res.end();
    });
  });
  opened.servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("番号が分からない");
  return { url: `http://127.0.0.1:${String(address.port)}`, received };
}

/**
 * 空の置き場を作る。テストの後に消す
 * @returns 置き場の道
 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ko-sdk-"));
  opened.dirs.push(dir);
  return dir;
}

/**
 * 本物の SDK を、宛先だけを代わりの Claude API に、置き場とホームを手元の空の所に替えて呼ぶ。コンテナでは宛先を変えず、受け手がプロキシに回す
 * @param baseUrl 代わりの Claude API
 * @param work 動く置き場
 * @returns SDK を呼ぶ関数
 */
async function localQuery(baseUrl: string, work: string): Promise<QueryFn> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return (params) => query({ ...params, options: { ...params.options, cwd: work, env: { ...params.options.env, ANTHROPIC_BASE_URL: baseUrl, HOME: work } } });
}

/**
 * ゲートウェイのルールの判断の代わりを作る
 * @param allow 通すか
 * @param asked 聞かれたツールの名前を足す並び
 * @returns fetch の代わり
 */
function gate(allow: boolean, asked: string[]): Fetcher {
  return (_url, init) => {
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    asked.push(isRecord(body) ? String(body["toolName"]) : "");
    return Promise.resolve(Response.json({ data: { allow, reason: allow ? "通す" : "ルールで断る" }, meta: { traceId: "t" } }));
  };
}

/**
 * タスク 1 件の呼び出しを作る
 * @param fetcher ゲートウェイの代わり
 * @param sessions 知らされた session を足す並び
 * @returns SDK の呼び出し
 */
function task(fetcher: Fetcher, sessions: string[]): AgentCall {
  const hook = preToolUse({ fetcher, token: () => "ticket-1", clock: { now: () => 0 }, record: () => {} });
  return {
    prompt: "ログインを直す",
    options: agentOptions({ ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目の説明文 v1", hook, abortController: new AbortController() }),
    onSession: (id) => sessions.push(id),
  };
}

/**
 * 受けた要求の中の tool_result を探す
 * @param received 受けた要求
 * @returns 見つかった tool_result
 */
function toolResults(received: Received[]): Record<string, unknown>[] {
  const messages = received.flatMap((r) => (Array.isArray(r.body["messages"]) ? (r.body["messages"] as unknown[]) : []));
  const blocks = messages.flatMap((m) => (isRecord(m) && Array.isArray(m["content"]) ? (m["content"] as unknown[]) : []));
  return blocks.filter(isRecord).filter((b) => b["type"] === "tool_result");
}

describe("ワークスペースの Claude Agent SDK", () => {
  it("設定を読ませず、決めた権限とフックと環境変数だけで SDK を呼ぶ", async () => {
    const seen: Parameters<QueryFn>[0][] = [];
    const run: QueryFn = async function* (params) {
      seen.push(params);
      yield { type: "result", subtype: "success", session_id: "session-1" };
    };
    const sessions: string[] = [];
    await sdkAgent(run)(task(gate(true, []), sessions));
    const options = seen[0]?.options;
    expect(seen[0]?.prompt).toBe("ログインを直す");
    expect(options).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目の説明文 v1", settingSources: [], cwd: "/work", permissionMode: "dontAsk" });
    expect(Object.keys(options?.env ?? {}).toSorted()).toEqual(["ANTHROPIC_API_KEY", "HOME", "NODE_EXTRA_CA_CERTS", "PATH"]);
    expect(options?.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options?.resume).toBeUndefined();
    expect(sessions).toEqual(["session-1"]);
  });

  it("続きから呼ぶ時は session と止める口を渡す", () => {
    const call = task(gate(true, []), []);
    const options = sdkOptions({ ...call.options, resume: "session-1" });
    expect(options.resume).toBe("session-1");
    expect(options.abortController).toBe(call.options.abortController);
  });

  it("SDK が失敗で終えたら投げる", async () => {
    await expect(sdkAgent(failing)(task(gate(true, []), []))).rejects.toThrow("error_during_execution");
  });

  it("本物の SDK が作業トークンを鍵にして Claude を呼び、session を知らせて終わる", async () => {
    const claude = await fakeClaude([[{ type: "text", text: "直した" }]]);
    const sessions: string[] = [];
    await sdkAgent(await localQuery(claude.url, tempDir()))(task(gate(true, []), sessions));
    const main = claude.received.find((r) => r.body["model"] === "claude-sonnet-5-5");
    expect(main?.key).toBe("ticket-1");
    expect(JSON.stringify(main?.body["system"])).toContain("役目の説明文 v1");
    expect(sessions).toHaveLength(1);
  });

  it("本物の SDK はツールを使う前にフックを聞き、通した時だけ動かす", async () => {
    const work = tempDir();
    const claude = await fakeClaude([[{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "touch made.txt" } }]]);
    const asked: string[] = [];
    await sdkAgent(await localQuery(claude.url, work))(task(gate(true, asked), []));
    expect(asked).toEqual(["Bash"]);
    expect(existsSync(join(work, "made.txt"))).toBe(true);
    expect(toolResults(claude.received)).toEqual([expect.objectContaining({ tool_use_id: "toolu_1" })]);
  });

  it("本物の SDK はフックが断ったツールを動かさず、理由を返す", async () => {
    const work = tempDir();
    const claude = await fakeClaude([[{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "touch made.txt" } }]]);
    const asked: string[] = [];
    await sdkAgent(await localQuery(claude.url, work))(task(gate(false, asked), []));
    expect(asked).toEqual(["Bash"]);
    expect(existsSync(join(work, "made.txt"))).toBe(false);
    expect(JSON.stringify(toolResults(claude.received))).toContain("ルールで断る");
  });
});
