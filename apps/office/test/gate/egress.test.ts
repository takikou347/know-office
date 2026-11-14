// ワークスペースの外向きの通信が、ゲートウェイの受け手だけに出る事を確かめる (社員が考えるの 1.2、3.1、4 章)
import { describe, expect, it } from "vitest";
import { routeEgress, WORKSPACE_EGRESS, type Caller } from "../../src/gate/egress.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { type ContainerLike, WorkspaceBox } from "../../src/gate/work/workspace-box.ts";
import { jst, NODE, startWork, useGuardWorld } from "../helpers/guard.ts";

const w = useGuardWorld();

/** 受け手の代わり。誰から来たかを持つ */
type FakeEgress = { caller: Caller; fetch(): Promise<Response> };
/** 代わりのコンテナが受けた事 */
type Seen = { started: ContainerStartOptions[]; intercepts: [string, string, Caller][]; fetched: string[] };
type ContainerStartOptions = Parameters<ContainerLike["start"]>[0];

/**
 * 起こし方と受け手の付け方を並べる、代わりのコンテナを作る
 * @param healthy /v1/health に答えるか
 * @returns コンテナと受けた事
 */
function fakeContainer(healthy = true): { container: ContainerLike<FakeEgress>; seen: Seen } {
  const seen: Seen = { started: [], intercepts: [], fetched: [] };
  let running = false;
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
      fetch: (url) => {
        seen.fetched.push(url);
        return healthy ? Promise.resolve(Response.json({ data: { ok: true, part: "workspace" }, meta: { traceId: "t" } })) : Promise.reject(new Error("まだ起きていない"));
      },
    }),
    destroy: () => {
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
    await new WorkspaceBox(container, egressFor, caller, () => Promise.resolve()).start();
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
    await new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, () => Promise.resolve()).start();
    // 受け手を付けた宛先のほかは、コンテナの外向きの通信を切って届かなくする
    expect(seen.started).toHaveLength(1);
    expect(seen.started[0]?.enableInternet).toBe(false);
    // 受け手に来ても、知らない宛先は断る
    for (const url of ["https://example.com/", "http://example.com/", "http://1.1.1.1/", "http://api.anthropic.com/v1/messages"]) {
      const res = await send(url);
      expect(res.status).toBe(403);
    }
  });

  it("受け手は http の 80 番と https の 443 番だけを受け、ほかの番号は 403 で断る", async () => {
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
});

describe("ワークスペースの起こし方", () => {
  it("/v1/health が返るまで待ち、60 秒で起きなければ 30 秒おきに 3 回やり直してから失敗を返す", async () => {
    const { container, seen } = fakeContainer(false);
    const waits: number[] = [];
    const box = new WorkspaceBox(container, egressFor, { staffId: "builder", workspaceId: "ws-builder" }, (ms) => Promise.resolve(void waits.push(ms)));
    await expect(box.start()).rejects.toMatchObject({ code: "unavailable" });
    expect(seen.started).toHaveLength(4);
    expect(waits.filter((ms) => ms === 30_000)).toHaveLength(3);
    expect(seen.fetched.every((url) => url.endsWith("/v1/health"))).toBe(true);
  });
});
