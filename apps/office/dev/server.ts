// 代わりの物を 1 つの Node のサーバーにまとめて立てる。ログインと記録の 3.9
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createFakeAccess, type FakeAccess, type FakeAccessOptions } from "./access.ts";
import { createFakeClaude, type FakeClaude } from "./claude.ts";
import { createFakeGitHub, type FakeGitHub } from "./github.ts";
import { createDevWorkspaces, type DevWorkspaces } from "./workspace.ts";
import { devUpgrade } from "./workspace-upgrade.ts";

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
 * 代わりの物を /access、/anthropic、/github、/codeload、/workspace の下に立てる
 * @param options 待ち受けの番号、手元のゲートウェイの宛先を返す関数、代わりの Access の設定、通す Claude の鍵
 * @returns 立てた代わりの物
 */
export async function startFakes(options: FakeAccessOptions & { port: number; gateBase: () => string; claudeKey: string }): Promise<RunningFakes> {
  const access = await createFakeAccess(options);
  // ゲートウェイの鍵だけを通す。ワークスペースの Claude の呼び出しもゲートウェイのプロキシが鍵を付け替えて届く
  const claude = createFakeClaude({ keys: [options.claudeKey] });
  // tarball の 302 の先は、ここに立てた codeload の形の道にする。ゲートウェイは DEV_FAKES_URL (localhost) の下だけを追う
  const github = createFakeGitHub({ codeloadBase: `http://localhost:${String(options.port)}/codeload`, hookUrl: () => `${options.gateBase()}/hooks/v1/github` });
  // 代わりのワークスペースは、出来事も SDK の Claude の呼び出しも手元のゲートウェイの開発の道に送る。Claude の呼び出しはゲートウェイのプロキシからここの代わりの Claude API に届く
  const workspaces = createDevWorkspaces(options.gateBase);
  const app = new Hono().route("/access", access.app).route("/anthropic", claude.app).route("/github", github.app).route("/codeload", github.codeload).route("/workspace", workspaces.app);
  const server = serve({ fetch: app.fetch, port: options.port, hostname: "127.0.0.1" });
  // 補完の切り替えは Hono を通らないので、upgrade を受けて Node のワークスペースへ TCP で渡す
  server.on("upgrade", devUpgrade(workspaces));
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
