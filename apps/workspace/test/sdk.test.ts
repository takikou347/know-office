// ワークスペースが Claude Agent SDK を、設定を読ませず、作業トークンを鍵に、フックを関数で渡して呼ぶ事を確かめる (社員が考えるの 3.1、3.2)
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "@know-office/core";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { agentOptions, type AgentCall, staffHome } from "../src/agent.ts";
import { preToolUse } from "../src/hooks.ts";
import { type QueryFn, type RelayProbe, relayProbe, sdkAgent, sdkOptions } from "../src/sdk.ts";
import { STAFF_GID, STAFF_UID, staffSpawner } from "../src/spawn.ts";
import { staffServer } from "../src/staff-tools.ts";
import { sessionFile, TranscriptShipper } from "../src/transcript.ts";

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
 * 出来事を 3 つ流して成功で終える SDK の代わり
 * @yields 始まり、返事、成功の result
 */
const threeEvents: QueryFn = async function* () {
  yield { type: "system", subtype: "init", session_id: "session-1" };
  yield { type: "assistant", session_id: "session-1" };
  yield { type: "result", subtype: "success", session_id: "session-1" };
};

/**
 * SDK が失敗で終える代わり
 * @yields 失敗の result
 */
const failing: QueryFn = async function* () {
  yield { type: "result", subtype: "error_during_execution", session_id: "session-1" };
};

/**
 * 終わりの文を返して成功で終える SDK の代わり
 * @yields 成功の result
 */
const finished: QueryFn = async function* () {
  yield { type: "result", subtype: "success", is_error: false, result: "直した", session_id: "session-1" };
};

/**
 * 鍵の失敗で待ち直しを始める SDK の代わりを作る
 * @param status 失敗のステータス
 * @returns SDK の代わり
 */
function retried(status: number): QueryFn {
  return async function* () {
    yield { type: "system", subtype: "api_retry", error: "authentication_failed", error_status: status, session_id: "session-1" };
  };
}

/**
 * success でも API の失敗で終える SDK の代わりを作る
 * @param status 失敗のステータス
 * @returns query の代わり
 */
function ended(status: number): QueryFn {
  return async function* () {
    yield { type: "result", subtype: "success", is_error: true, api_error_status: status, result: "Invalid API key sk-ant-abc", session_id: "session-1" };
  };
}

/**
 * ゲートウェイのプロキシが断ったと答える確かめ
 * @returns refused
 */
const refused: RelayProbe = () => Promise.resolve("refused");
/**
 * 確かめられなかったと答える確かめ
 * @returns unknown
 */
const unknown: RelayProbe = () => Promise.resolve("unknown");

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
 * @param home ホーム。SDK は会話の記録をこの下に書く。省くと動く置き場と同じ
 * @returns SDK を呼ぶ関数
 */
async function localQuery(baseUrl: string, work: string, home = work): Promise<QueryFn> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return (params) => query({ ...params, options: { ...params.options, cwd: work, env: { ...params.options.env, ANTHROPIC_BASE_URL: baseUrl, HOME: home } } });
}

/**
 * ゲートウェイのルールの判断の代わりを作る
 * @param allow 通すか
 * @param asked 聞かれたツールの名前を足す並び
 * @param called 社員のツールの口が受けた名前と本文を足す並び
 * @returns fetch の代わり
 */
function gate(allow: boolean, asked: string[], called: string[] = []): Fetcher {
  return (url, init) => {
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    // 社員のツールの口は、呼ばれたツールの名前と入力を控え、決まった答えを返す
    if (url.includes("/ws/v1/tools/")) {
      called.push(`${url.split("/").at(-1) ?? ""} ${JSON.stringify(body)}`);
      return Promise.resolve(Response.json({ data: { content: "社長に plan を足した", isError: false }, meta: { traceId: "t" } }));
    }
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
    options: agentOptions({
      ticket: "ticket-1",
      model: "claude-sonnet-5-5",
      effort: "medium",
      systemPrompt: "役目の説明文 v1",
      hook,
      staff: staffServer({ fetcher, token: () => "ticket-1" }, ["ask_boss"]),
      abortController: new AbortController(),
    }),
    onSession: (id) => sessions.push(id),
    onEvent: () => {},
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
    expect(Object.keys(options?.env ?? {}).toSorted()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "HOME",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
    ]);
    // 裏の軽い呼び出しも、役で許した軽いモデルにする。決まった宛先のほかへの通信は切る
    expect(options?.env).toMatchObject({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5", ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-5-5", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(options?.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    // MCP の受け手は社員のツールの staff だけで、ほかの置き場の MCP の設定を読まない
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(["staff"]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.resume).toBeUndefined();
    expect(sessions).toEqual(["session-1"]);
  });

  it("社員の SDK とコマンドは staff の uid と gid で起こす", () => {
    const seen: unknown[][] = [];
    const child = new EventEmitter();
    const spawner = staffSpawner({ spawn: (...args: unknown[]) => (seen.push(args), child), uid: () => 0 });
    const signal = new AbortController().signal;
    expect(spawner({ command: "node", args: ["cli.js"], cwd: "/work", env: { A: "1" }, signal })).toBe(child);
    expect(seen).toEqual([["node", ["cli.js"], { cwd: "/work", env: { A: "1" }, signal, uid: STAFF_UID, gid: STAFF_GID, stdio: ["pipe", "pipe", "ignore"] }]]);
    expect([STAFF_UID, STAFF_GID]).toEqual([10001, 10001]);
    // SDK には渡した時だけ付ける
    const call = task(gate(true, []), []);
    expect(sdkOptions(call.options, spawner).spawnClaudeCodeProcess).toBe(spawner);
    expect(sdkOptions(call.options).spawnClaudeCodeProcess).toBeUndefined();
  });

  it("root でないサーバーは社員を起こさず断る", () => {
    let spawned = 0;
    const spawner = staffSpawner({ spawn: () => ((spawned += 1), new EventEmitter()), uid: () => 10002 });
    expect(() => spawner({ command: "node", args: [], env: {}, signal: new AbortController().signal })).toThrow(/root/);
    expect(spawned).toBe(0);
  });

  it("SDK に渡すホームは、サーバーの HOME でなく社員のホーム", () => {
    const before = process.env["HOME"];
    process.env["HOME"] = "/root";
    try {
      expect(staffHome()).toBe("/home/staff");
    } finally {
      process.env["HOME"] = before;
    }
  });

  it("続きから呼ぶ時は session と止める口を渡す", () => {
    const call = task(gate(true, []), []);
    const options = sdkOptions({ ...call.options, resume: "session-1" });
    expect(options.resume).toBe("session-1");
    expect(options.abortController).toBe(call.options.abortController);
  });

  it("SDK の出来事を 1 つ読むたびに知らせる", async () => {
    let events = 0;
    await sdkAgent(threeEvents)({ ...task(gate(true, []), []), onEvent: () => void (events += 1) });
    expect(events).toBe(3);
  });

  it("SDK が失敗で終えたら投げる", async () => {
    await expect(sdkAgent(failing)(task(gate(true, []), []))).rejects.toThrow("error_during_execution");
  });

  it("SDK が終わりの文を返す", async () => {
    expect(await sdkAgent(finished)(task(gate(true, []), []))).toBe("直した");
  });

  it("success でも API の失敗で終えた時は投げ、Claude API 自身の 401 と 403 だけを鍵の失敗にする", async () => {
    const asked: string[] = [];
    const upstream: RelayProbe = (ticket, model) => {
      asked.push(`${ticket} ${model}`);
      return Promise.resolve("upstream");
    };
    await expect(sdkAgent(ended(401), undefined, upstream)(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_auth_failed" });
    await expect(sdkAgent(ended(403), undefined, upstream)(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_auth_failed" });
    await expect(sdkAgent(ended(500), undefined, upstream)(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_failed" });
    // 確かめは作業トークンと呼び出しのモデルで行い、500 では確かめない
    expect(asked).toEqual(["ticket-1 claude-sonnet-5-5", "ticket-1 claude-sonnet-5-5"]);
    // SDK の文は鍵を含みうるので、投げる文に入れない
    await expect(sdkAgent(ended(401), undefined, upstream)(task(gate(true, []), []))).rejects.not.toThrow(/sk-ant/);
  });

  it("relay が 401 を返しても sdk_auth_failed にならない", async () => {
    await expect(sdkAgent(ended(401), undefined, refused)(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_failed" });
    await expect(sdkAgent(retried(401), undefined, refused)(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_failed" });
    // 確かめられない時も、ほかの社員まで止める鍵の失敗にしない
    await expect(sdkAgent(retried(401), undefined, unknown)(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_failed" });
  });

  it("本物の SDK に Claude が 401 を返すと、待ち直さずに鍵の失敗で投げる", async () => {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      });
    });
    opened.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("番号が分からない");
    const base = `http://127.0.0.1:${String(address.port)}`;
    const run = await localQuery(base, tempDir());
    await expect(sdkAgent(run, undefined, relayProbe(base))(task(gate(true, []), []))).rejects.toMatchObject({ name: "sdk_auth_failed" });
  }, 10_000);

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

  it("本物の SDK の会話の記録を作り直したワークスペースに戻すと、同じ session の続きを呼ぶ", async () => {
    const work = tempDir();
    const claude = await fakeClaude([[{ type: "text", text: "半分まで直した" }]]);
    const sessions: string[] = [];
    // 落ちる前のワークスペース。SDK が会話の記録をホームの下に書く
    const before = tempDir();
    await sdkAgent(await localQuery(claude.url, work, before))(task(gate(true, []), sessions));
    const sessionId = sessions[0] ?? "";
    const written = readFileSync(sessionFile(before, work, sessionId));
    expect(written.toString("utf8")).toContain("ログインを直す");
    // 作り直したワークスペースは空のホームから始め、社員 DO が戻した記録を書く
    const after = tempDir();
    const shipper = new TranscriptShipper({ fetcher: () => Promise.resolve(new Response(null, { status: 204 })), home: after, cwd: work });
    await shipper.restore({ sessionId, transcript: written.toString("base64"), nextSeq: 1 });
    claude.received.length = 0;
    const call = task(gate(true, []), []);
    await sdkAgent(await localQuery(claude.url, work, after))({ ...call, prompt: "続きから進める", options: { ...call.options, resume: sessionId } });
    const main = claude.received.find((r) => r.body["model"] === "claude-sonnet-5-5");
    // 前の指示と返事が、続きの呼び出しの会話に入っている
    expect(JSON.stringify(main?.body["messages"])).toContain("ログインを直す");
    expect(JSON.stringify(main?.body["messages"])).toContain("半分まで直した");
    expect(JSON.stringify(main?.body["messages"])).toContain("続きから進める");
  });

  it("本物の SDK は、フックが通した社員のツールを受け手 staff でゲートウェイに渡し、答えを返す", async () => {
    const claude = await fakeClaude([[{ type: "tool_use", id: "toolu_1", name: "mcp__staff__ask_boss", input: { reason: "次のタスクが無い" } }]]);
    const asked: string[] = [];
    const called: string[] = [];
    await sdkAgent(await localQuery(claude.url, tempDir()))(task(gate(true, asked, called), []));
    expect(asked).toEqual(["mcp__staff__ask_boss"]);
    expect(called).toEqual([`ask_boss ${JSON.stringify({ toolInput: { reason: "次のタスクが無い" } })}`]);
    expect(JSON.stringify(toolResults(claude.received))).toContain("社長に plan を足した");
  });

  it("本物の SDK は、フックが断った社員のツールをゲートウェイに渡さない", async () => {
    const claude = await fakeClaude([[{ type: "tool_use", id: "toolu_1", name: "mcp__staff__ask_boss", input: { reason: "次のタスクが無い" } }]]);
    const called: string[] = [];
    await sdkAgent(await localQuery(claude.url, tempDir()))(task(gate(false, [], called), []));
    expect(called).toEqual([]);
    expect(JSON.stringify(toolResults(claude.received))).toContain("ルールで断る");
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
