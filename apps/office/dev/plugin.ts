// 開発用の vite のプラグイン。代わりの物を立て、API への要求に代わりの Access の証明を付ける。ログインと記録の 3.9
import type { IncomingMessage } from "node:http";
import { systemClock } from "@know-office/core";
import type { Plugin } from "vite";
import { startFakes } from "./server.ts";

const PROTECTED = /^\/(api|ws)\//;

/**
 * API とワークスペースへの要求に証明を付ける。ブラウザーが送った物は置き換える
 * @param req 要求
 * @param sign 証明を出す関数
 */
export async function attachAccess(req: IncomingMessage, sign: () => Promise<string>): Promise<void> {
  if (!PROTECTED.test(req.url ?? "")) return;
  req.headers["cf-access-jwt-assertion"] = await sign();
}

/**
 * 開発の時だけ代わりの物を立てるプラグインを作る
 * @param port 代わりの物の待ち受けの番号
 * @returns vite のプラグイン
 */
export function devFakes(port = 5199): Plugin {
  return {
    name: "know-office-dev-fakes",
    apply: "serve",
    async configureServer(server) {
      const fakes = await startFakes({ port, team: "dev", aud: "dev-aud", email: "owner@example.com", clock: systemClock });
      server.httpServer?.once("close", () => fakes.close());
      server.middlewares.use((req, _res, next) => {
        attachAccess(req, fakes.access.sign).then(() => next(), next);
      });
    },
  };
}
