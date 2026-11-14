// 代わりの物を 1 つの Node のサーバーにまとめて立てる。ログインと記録の 3.9
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFakeAccess, type FakeAccess, type FakeAccessOptions } from "./access.ts";
import { createFakeClaude, type FakeClaude } from "./claude.ts";
import { createFakeGitHub, type FakeGitHub } from "./github.ts";

/** 立てた代わりの物 */
export type RunningFakes = {
  /** 代わりの Access */
  access: FakeAccess;
  /** 代わりの Claude API */
  claude: FakeClaude;
  /** 代わりの GitHub */
  github: FakeGitHub;
  /** 止める */
  close(): void;
};

/**
 * 代わりの物を /access、/anthropic、/github の下に立てる
 * @param options 待ち受けの番号と、代わりの Access の設定
 * @returns 立てた代わりの物
 */
export async function startFakes(options: FakeAccessOptions & { port: number }): Promise<RunningFakes> {
  const access = await createFakeAccess(options);
  const claude = createFakeClaude();
  const github = createFakeGitHub();
  const app = new Hono().route("/access", access.app).route("/anthropic", claude.app).route("/github", github.app);
  const server = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" });
  return { access, claude, github, close: () => server.close() };
}
