// 開発環境のコンテナの代わりが、development で手元の代わりの物がある時だけ使われ、Node のワークスペースへ要求を回す事を確かめる (ログインと記録の 3.9、社員が考えるの 3.1)
import { describe, expect, it } from "vitest";
import { containerFor, DevContainer } from "../../src/gate/work/dev-container.ts";
import type { ContainerLike } from "../../src/gate/work/workspace-box.ts";

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
