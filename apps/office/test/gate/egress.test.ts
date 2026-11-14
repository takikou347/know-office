// ワークスペースの外向きの通信が、ゲートウェイの受け手だけに出る事を確かめる (社員が考えるの 1.2、3.1、4 章)
import { describe, expect, it } from "vitest";
import { routeEgress, WORKSPACE_EGRESS, type Caller } from "../../src/gate/egress.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { type BoxDeps, type ContainerLike, noticeWorkspaceDown, WorkspaceBox } from "../../src/gate/work/workspace-box.ts";
import { jst, NODE, rows, startWork, useGuardWorld } from "../helpers/guard.ts";

const w = useGuardWorld();

/** 受け手の代わり。誰から来たかを持つ */
type FakeEgress = { caller: Caller; fetch(): Promise<Response> };
/** 代わりのコンテナが受けた事 */
type Seen = { started: ContainerStartOptions[]; intercepts: [string, string, Caller][]; fetched: string[]; headers: Headers[]; destroyed: number };
type ContainerStartOptions = Parameters<ContainerLike["start"]>[0];

/**
 * 起こし方と受け手の付け方を並べる、代わりのコンテナを作る
 * @param healthy /v1/health に答えるか
 * @param runningAtFirst 初めから動いているか。DO が起き直した時の、前から動いているコンテナ
 * @returns コンテナと受けた事
 */
function fakeContainer(healthy = true, runningAtFirst = false): { container: ContainerLike<FakeEgress>; seen: Seen } {
  const seen: Seen = { started: [], intercepts: [], fetched: [], headers: [], destroyed: 0 };
  let running = runningAtFirst;
  const container: ContainerLike<FakeEgress> = {
    get running() {
      return running;
    },
    start: (options) => {
      seen.started.push(options);
      running = true;
    },
    interceptOutboundHttp: (host, fetcher) => Promise.resolve(void seen.intercepts.push(["http", host, fetcher.caller])),
    interceptOutboundHttps: (host, fetcher) => Promise.resolve(void seen.intercepts.push(["https", host, fetcher.caller])),
    getTcpPort: () => ({
      fetch: (url, init) => {
        seen.fetched.push(url);
        seen.headers.push(new Headers(init?.headers));
        if (!healthy) return Promise.reject(new Error("まだ起きていない"));
        if (url.endsWith("/v1/runs")) return Promise.resolve(new Response(null, { status: 202 }));
        if (url.endsWith("/v1/ticket")) return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(Response.json({ data: { ok: true, part: "workspace" }, meta: { traceId: "t" } }));
      },
    }),
    destroy: () => {
      seen.destroyed += 1;
      running = false;
      return Promise.resolve();
    },
  };
  return { container, seen };
}

/**
 * 受け手の代わりを作る。誰から来たかを持つ
 * @param caller 送るワークスペース
 * @returns 受け手
 */
function egressFor(caller: Caller): FakeEgress {
  return { caller, fetch: () => Promise.resolve(new Response("")) };
}

/** ワークスペースの鍵を置く所の代わり */
type FakeKeys = { value: string | undefined; get(): Promise<string | undefined>; put(key: string): Promise<void> };

/**
 * ワークスペースの鍵を置く所の代わりを作る
 * @returns 置いた鍵を持つ入れ物
 */
function fakeKeys(): FakeKeys {
  const keys: FakeKeys = {
    value: undefined,
    get: () => Promise.resolve(keys.value),
    // 記憶に書くのは待ちが入るので、1 回待ってから置く。同じ時に起こした時の食い違いを出す
    put: async (key) => {
      await Promise.resolve();
      keys.value = key;
    },
  };
  return keys;
}

/**
 * 待たずに数える依り所を作る
 * @param waits 待った長さを足す先
 * @param keys 鍵を置く所
 * @param downs 起きなかった知らせを足す先
 * @returns WorkspaceBox の依り所
 */
function boxDeps(waits: number[] = [], keys: FakeKeys = fakeKeys(), downs: number[] = []): BoxDeps {
  return { wait: (ms) => Promise.resolve(void waits.push(ms)), keys, notifyDown: () => Promise.resolve(void downs.push(1)) };
}

/**
 * ワークスペースの要求を受け手に渡す
 * @param url 宛先
 * @param init 要求の中身
 * @returns 受け手の返事
 */
function send(url: string, init: RequestInit = {}): Promise<Response> {
  const caller: Caller = { staffId: "builder", workspaceId: workspaceIdOf(w.gate.env, "builder") };
  return routeEgress(new Request(url, init), w.gate.env, caller, { clock: w.clock, guard: w.gate.deps });
}

describe("鍵はゲートウェイだけが持つ", () => {
  it("ワークスペースが外へ出る", async () => {
    const { container, seen } = fakeContainer();
    const caller: Caller = { staffId: "builder", workspaceId: "ws-builder" };
    await new WorkspaceBox(container, egressFor, caller, boxDeps()).start();
    // ゲートウェイ、Claude、GitHub の宛先だけを、送ったワークスペースを結んだゲートウェイの受け手に回す
    expect(seen.intercepts.toSorted((a, b) => a[1].localeCompare(b[1]))).toEqual([
      ["https", "api.anthropic.com", caller],
      ["https", "api.github.com", caller],
      ["http", "gate.internal", caller],
    ]);
    expect(WORKSPACE_EGRESS).toEqual({ http: ["gate.internal"], https: ["api.anthropic.com", "api.github.com"] });
    // Claude と GitHub の呼び出しはゲートウェイが作業トークンを確かめる。無ければ外へ出ずに断る
    w.clock.advance(jst(9, 1) - w.clock.now());
    for (const [url, header] of [
      ["https://api.anthropic.com/v1/messages", "x-api-key"],
      ["https://api.github.com/repos/o/r/pulls", "authorization"],
    ] as const) {
      const res = await send(url, { method: "POST", headers: { [header]: "sk-ant-not-a-ticket" }, body: "{}" });
      expect(res.status).toBe(401);
    }
    await startWork(w, "builder");
    const { token } = await issueTicket(w.gate.env, "builder", NODE, jst(9));
    const res = await send("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: "{}" });
    expect(res.status).not.toBe(401);
  });

  it("ワークスペースから直に外へ出る", async () => {
    const { container, seen } = fakeContainer();
    await new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps()).start();
    // 受け手を付けた宛先のほかは、コンテナの外向きの通信を切って届かなくする
    expect(seen.started).toHaveLength(1);
    expect(seen.started[0]?.enableInternet).toBe(false);
    // 受け手に来ても、知らない宛先は断る
    for (const url of ["https://example.com/", "http://example.com/", "http://1.1.1.1/", "http://api.anthropic.com/v1/messages"]) {
      const res = await send(url);
      expect(res.status).toBe(403);
    }
  });

});

describe("ワークスペースの起こし方", () => {
  it("/v1/health が返るまで待ち、60 秒で起きなければ 30 秒おきに 3 回やり直してから失敗を返す", async () => {
    const { container, seen } = fakeContainer(false);
    const waits: number[] = [];
    const downs: number[] = [];
    const box = new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps(waits, fakeKeys(), downs));
    await expect(box.start()).rejects.toMatchObject({ code: "unavailable" });
    expect(seen.started).toHaveLength(4);
    expect(waits.filter((ms) => ms === 30_000)).toHaveLength(3);
    expect(seen.fetched.every((url) => url.endsWith("/v1/health"))).toBe(true);
    // 4 回とも起きなければ 1 度だけ知らせる
    expect(downs).toHaveLength(1);
  });

  it("起きた時は知らせない", async () => {
    const { container } = fakeContainer();
    const downs: number[] = [];
    await new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps([], fakeKeys(), downs)).start();
    expect(downs).toEqual([]);
  });

  it("知らせが失敗しても、起きなかった事を unavailable で返す", async () => {
    const { container } = fakeContainer(false);
    const deps: BoxDeps = { ...boxDeps(), notifyDown: () => Promise.reject(new Error("D1 が止まっている")) };
    await expect(new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, deps).start()).rejects.toMatchObject({ code: "unavailable" });
  });

});

describe("ワークスペースのハートビート", () => {
  it("ワークスペースが 4 回起きない", async () => {
    /**
     * 起きないコンテナを、通知を D1 に書く依り所で起こす
     * @param staffId 社員 ID
     * @param at 通知の時刻
     */
    const failToStart = async (staffId: "builder" | "reviewer", at: number) => {
      const { container, seen } = fakeContainer(false);
      const deps: BoxDeps = { ...boxDeps(), notifyDown: () => noticeWorkspaceDown(w.gate.env.DB, staffId, at) };
      await expect(new WorkspaceBox(container, egressFor, { staffId, workspaceId: `ws-${staffId}` }, deps).start()).rejects.toMatchObject({ code: "unavailable" });
      expect(seen.started).toHaveLength(4);
    };
    await failToStart("builder", jst(9));
    await failToStart("builder", jst(9, 5));
    await failToStart("reviewer", jst(9, 5));
    const notices = () => rows(w, "SELECT level, kind, title, body, scope, read_at FROM notices WHERE kind = 'workspace_down' ORDER BY at, title");
    const body = "4 回起こしても /v1/health が返らなかった。社員はワークスペースを待ち、ハートビートが届かない間は起こし直す";
    // 同じ社員の通知は、オーナーが読むまで重ねない
    expect(await notices()).toEqual([
      { level: "warn", kind: "workspace_down", title: "builder のワークスペースが起きない", body, scope: "office", read_at: null },
      { level: "warn", kind: "workspace_down", title: "reviewer のワークスペースが起きない", body, scope: "office", read_at: null },
    ]);
    await w.gate.env.DB.prepare("UPDATE notices SET read_at = ? WHERE kind = 'workspace_down'").bind(jst(9, 10)).run();
    await failToStart("builder", jst(10));
    expect(await notices()).toHaveLength(3);
  });
});

describe("ワークスペースを分ける", () => {
  it("許していない番号へ出る", async () => {
    // 受け手は http の 80 番と https の 443 番だけを受ける
    for (const url of ["http://gate.internal:8080/ws/v1/heartbeat", "http://gate.internal:443/ws/v1/heartbeat", "https://api.anthropic.com:8443/v1/messages", "https://api.github.com:80/repos/o/r"]) {
      const res = await send(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect({ url, status: res.status }).toEqual({ url, status: 403 });
    }
    // 番号を書いても、決まった番号なら受ける
    w.clock.advance(jst(9, 1) - w.clock.now());
    const beat = await send("http://gate.internal:80/ws/v1/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: new Date(jst(9, 1)).toISOString() }) });
    expect(beat.status).toBe(204);
    expect((await send("https://api.anthropic.com:443/v1/messages", { method: "POST", body: "{}" })).status).toBe(401);
  });

  const RUN = { nodeId: NODE, ticket: "ticket-1", model: "claude-sonnet-5-5", effort: "medium", systemPrompt: "役目", prompt: "ログインを直す" };

  it("起こすたびに新しい鍵を作ってコンテナに渡し、タスクの開始と作業トークンの差し替えに付ける", async () => {
    const { container, seen } = fakeContainer();
    const keys = fakeKeys();
    const box = new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps([], keys));
    await box.start();
    const first = seen.started[0]?.env?.WORKSPACE_KEY;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.value).toBe(first);
    await box.run(RUN);
    await box.replaceTicket("ticket-2");
    expect(seen.headers.slice(-2).map((h) => h.get("authorization"))).toEqual([`Bearer ${String(first)}`, `Bearer ${String(first)}`]);
    await box.stop();
    await box.start();
    const second = seen.started[1]?.env?.WORKSPACE_KEY;
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(keys.value).toBe(second);
  });

  it("動いているコンテナの鍵が記憶に無ければ、止めて起こし直してから呼ぶ", async () => {
    // 前から動いているコンテナの鍵は分からないので、そのままでは呼べない
    const { container, seen } = fakeContainer(true, true);
    const keys = fakeKeys();
    const box = new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps([], keys));
    await box.run(RUN);
    expect(seen.destroyed).toBe(1);
    expect(seen.started).toHaveLength(1);
    const key = seen.started[0]?.env?.WORKSPACE_KEY;
    expect(keys.value).toBe(key);
    expect(seen.headers.at(-1)?.get("authorization")).toBe(`Bearer ${String(key)}`);
    // start() も同じく起こし直す
    const again = fakeContainer(true, true);
    await new WorkspaceBox(again.container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps()).start();
    expect(again.seen.destroyed).toBe(1);
    expect(again.seen.started).toHaveLength(1);
  });

  it("同じ時に起こしても 1 度だけ起こし、記憶とコンテナの鍵がそろう", async () => {
    const { container, seen } = fakeContainer();
    const keys = fakeKeys();
    const box = new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps([], keys));
    await Promise.all([box.start(), box.start(), box.run(RUN)]);
    expect(seen.started).toHaveLength(1);
    expect(keys.value).toBe(seen.started[0]?.env?.WORKSPACE_KEY);
    expect(seen.headers.at(-1)?.get("authorization")).toBe(`Bearer ${String(keys.value)}`);
    // 終わった後に起こせば、また起こす
    await box.stop();
    await box.start();
    expect(seen.started).toHaveLength(2);
  });

  it("起こしている途中に止めたら、起こし終えてから止める", async () => {
    const { container, seen } = fakeContainer();
    const box = new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, boxDeps());
    const starting = box.start();
    await box.stop();
    await starting;
    expect(seen.started).toHaveLength(1);
    expect(container.running).toBe(false);
  });
});
