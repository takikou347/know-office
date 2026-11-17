// 開発環境のコンテナの代わりが、development で手元の代わりの物がある時だけ使われ、Node のワークスペースへ要求を回す事を確かめる (ログインと記録の 3.9、社員が考えるの 3.2)
import { describe, expect, it } from "vitest";
import { containerFor, DevContainer } from "../../src/gate/work/dev-container.ts";
import { type ContainerLike, WorkspaceBox } from "../../src/gate/work/workspace-box.ts";

/** 代わりのワークスペースに届いた要求 */
type Sent = { url: string; body: string | null };

/**
 * 届いた要求を並べる fetch を作る
 * @returns fetch と届いた要求
 */
function recorder(): { fetcher: (url: string, init?: RequestInit) => Promise<Response>; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetcher = (url: string, init?: RequestInit) => {
    sent.push({ url, body: typeof init?.body === "string" ? init.body : null });
    return Promise.resolve(new Response(null, { status: url.endsWith("/v1/runs") ? 202 : 204 }));
  };
  return { fetcher, sent };
}

/**
 * 手元の開発のサーバーを起こした直後の受け手。サーバーは起こした直後は入口の出す物を wrangler.jsonc からしか知らず、ctx.exports に受け手がまだ無い
 * @returns 返さない
 */
function missingEgress(): never {
  throw new TypeError("this.ctx.exports.WorkspaceEgress is not a function");
}

describe("開発のコンテナの代わり", () => {
  it("development で手元の代わりの物がある時だけ、代わりのワークスペースに回す", async () => {
    const { fetcher, sent } = recorder();
    const container = containerFor({ ENVIRONMENT: "development", ACCESS_TEAM: "dev", DEV_FAKES_URL: "http://localhost:5199" }, undefined, "builder", fetcher);
    expect(container).toBeInstanceOf(DevContainer);
    container.start({ enableInternet: false, env: { WORKSPACE_KEY: "k".repeat(64) } });
    expect(container.running).toBe(true);
    await container.getTcpPort(8080).fetch("http://workspace/v1/runs", { method: "POST", body: "{}" });
    await container.destroy();
    expect(sent).toEqual([
      { url: "http://localhost:5199/workspace/builder/boot", body: JSON.stringify({ key: "k".repeat(64) }) },
      { url: "http://localhost:5199/workspace/builder/v1/runs", body: "{}" },
      { url: "http://localhost:5199/workspace/builder/stop", body: "{}" },
    ]);
    expect(container.running).toBe(false);
  });

  it("補完の切り替えは、クエリと Upgrade: websocket をそのまま代わりのワークスペースへ出す", async () => {
    const seen: { url: string; upgrade: string | null }[] = [];
    const fetcher = (url: string, init?: RequestInit) => {
      seen.push({ url, upgrade: new Headers(init?.headers).get("upgrade") });
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const container = containerFor({ ENVIRONMENT: "development", ACCESS_TEAM: "dev", DEV_FAKES_URL: "http://localhost:5199" }, undefined, "builder", fetcher);
    container.start({ enableInternet: false, env: { WORKSPACE_KEY: "k".repeat(64) } });
    const query = `nodeId=0190f4a8-0000-7000-8000-000000000101&sha=${"a".repeat(40)}`;
    await container.getTcpPort(8080).fetch(`http://workspace/v1/lsp?${query}`, { headers: { upgrade: "websocket" } });
    expect(seen.at(-1)).toEqual({ url: `http://localhost:5199/workspace/builder/v1/lsp?${query}`, upgrade: "websocket" });
    await container.destroy();
  });

  it.each([
    ["ENVIRONMENT が無い", undefined],
    ["本番", "production"],
    ["プレビュー", "preview"],
  ])("%s で ctx.container が無ければ internal で断り、代わりを作らない", (_, environment) => {
    const { fetcher, sent } = recorder();
    expect(() => containerFor({ ENVIRONMENT: environment, ACCESS_TEAM: "dev", DEV_FAKES_URL: "http://localhost:5199" }, undefined, "builder", fetcher)).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    expect(sent).toEqual([]);
  });

  it.each([["https://fakes.example.com"], ["http://10.0.0.1:5199"], [undefined]])("development でも代わりの置き場が手元でなければ (%s) 起こさない", (url) => {
    const { fetcher, sent } = recorder();
    expect(() => containerFor({ ENVIRONMENT: "development", ACCESS_TEAM: "dev", DEV_FAKES_URL: url }, undefined, "builder", fetcher)).toThrow(expect.objectContaining({ code: "internal" }));
    expect(sent).toEqual([]);
  });

  it("開発のサーバーを起こした直後で受け手がまだ無くても、代わりのワークスペースを起こす", async () => {
    const sent: string[] = [];
    const fetcher = (url: string) => {
      sent.push(url);
      return Promise.resolve(url.endsWith("/v1/health") ? Response.json({ data: { ok: true, part: "workspace" } }) : new Response(null, { status: 204 }));
    };
    const container = containerFor({ ENVIRONMENT: "development", ACCESS_TEAM: "dev", DEV_FAKES_URL: "http://localhost:5199" }, undefined, "builder", fetcher);
    let key: string | undefined;
    const deps = { wait: () => Promise.resolve(), keys: { get: () => Promise.resolve(key), put: (k: string) => Promise.resolve(void (key = k)) }, notifyDown: () => Promise.resolve() };
    await new WorkspaceBox(container, missingEgress, { staffId: "builder", workspaceId: "ws-builder" }, deps).start();
    expect(container.running).toBe(true);
    expect(sent).toEqual(["http://localhost:5199/workspace/builder/boot", "http://localhost:5199/workspace/builder/v1/health"]);
  });

  it("DO が入れ物を作り直しても、起こした代わりのワークスペースは動いていると覚え、止めた後は動いていないとする", async () => {
    const { fetcher } = recorder();
    const env = { ENVIRONMENT: "development", ACCESS_TEAM: "dev", DEV_FAKES_URL: "http://localhost:5199" };
    const first = containerFor(env, undefined, "reviewer", fetcher);
    expect(first.running).toBe(false);
    first.start({ enableInternet: false, env: { WORKSPACE_KEY: "k" } });
    // 作り直した DO の入れ物も、前の鍵のハートビートを受けるために動いていると見る
    const again = containerFor(env, undefined, "reviewer", fetcher);
    expect(again.running).toBe(true);
    await again.destroy();
    expect(containerFor(env, undefined, "reviewer", fetcher).running).toBe(false);
  });

  it("印の無い本物と同じ形の入れ物には、受け手を付けてから起こす", async () => {
    const seen: string[] = [];
    const real: ContainerLike<string> = {
      running: false,
      start: () => void seen.push("start"),
      interceptOutboundHttp: (host, fetcher) => Promise.resolve(void seen.push(`http ${host} ${fetcher}`)),
      interceptOutboundHttps: (host, fetcher) => Promise.resolve(void seen.push(`https ${host} ${fetcher}`)),
      getTcpPort: () => ({ fetch: () => Promise.resolve(Response.json({ data: { ok: true, part: "workspace" } })) }),
      destroy: () => Promise.resolve(),
    };
    let key: string | undefined;
    const deps = { wait: () => Promise.resolve(), keys: { get: () => Promise.resolve(key), put: (k: string) => Promise.resolve(void (key = k)) }, notifyDown: () => Promise.resolve() };
    await new WorkspaceBox(real, (caller) => `egress:${caller.staffId}`, { staffId: "builder", workspaceId: "ws-builder" }, deps).start();
    expect(seen).toEqual([
      "http gate.internal egress:builder",
      "https api.anthropic.com egress:builder",
      "https api.github.com egress:builder",
      "https github.com egress:builder",
      "start",
    ]);
  });

  it("本物のコンテナがあればそれを使う", () => {
    const { fetcher } = recorder();
    const real: ContainerLike = {
      running: false,
      start: () => undefined,
      interceptOutboundHttp: () => Promise.resolve(),
      interceptOutboundHttps: () => Promise.resolve(),
      getTcpPort: () => ({ fetch: () => Promise.resolve(new Response(null)) }),
      destroy: () => Promise.resolve(),
    };
    expect(containerFor({ ENVIRONMENT: "development", ACCESS_TEAM: "dev", DEV_FAKES_URL: "http://localhost:5199" }, real, "builder", fetcher)).toBe(real);
  });
});
