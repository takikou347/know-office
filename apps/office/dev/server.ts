// 代わりの物を 1 つの Node のサーバーにまとめて立てる。ログインと記録の 3.9
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFakeAccess, type FakeAccess, type FakeAccessOptions } from "./access.ts";
import { createFakeClaude, type FakeClaude } from "./claude.ts";
import { createFakeGitHub, type FakeGitHub } from "./github.ts";
import { createDevWorkspaces, type DevWorkspaces } from "./workspace.ts";

/** 立てた代わりの物 */
export type RunningFakes = {
  /** 代わりの Access */
  access: FakeAccess;
  /** 代わりの Claude API */
  claude: FakeClaude;
  /** 代わりの GitHub */
  github: FakeGitHub;
  /** 開発のコンテナの代わりが起こすワークスペース */
  workspaces: DevWorkspaces;
  /** 止める */
  close(): void;
};

/**
 * 代わりの物を /access、/anthropic、/github、/workspace の下に立てる
 * @param options 待ち受けの番号、手元のゲートウェイの宛先を返す関数、代わりの Access の設定
 * @returns 立てた代わりの物
 */
export async function startFakes(options: FakeAccessOptions & { port: number; gateBase: () => string }): Promise<RunningFakes> {
  const access = await createFakeAccess(options);
  const claude = createFakeClaude();
  const github = createFakeGitHub();
  // 代わりのワークスペースは、出来事も SDK の Claude の呼び出しも手元のゲートウェイの開発の道に送る。Claude の呼び出しはゲートウェイのプロキシからここの代わりの Claude API に届く
  const workspaces = createDevWorkspaces(options.gateBase);
  const app = new Hono().route("/access", access.app).route("/anthropic", claude.app).route("/github", github.app).route("/workspace", workspaces.app);
  const server = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" });
  return {
    access,
    claude,
    github,
    workspaces,
    close: () => {
      void workspaces.close();
      server.close();
    },
  };
}
