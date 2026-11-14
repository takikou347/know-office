// 開発用の vite のプラグイン。代わりの物を立て、API への要求に代わりの Access の証明を付ける。ログインと記録の 3.9
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
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

/** .dev.vars から読む、代わりの物の設定 */
export type DevVars = {
  /** 代わりの物の待ち受けの番号 (DEV_FAKES_URL のポート) */
  port: number;
  /** Access のチーム名 */
  team: string;
  /** Access の宛先 (aud) */
  aud: string;
  /** オーナーのメールアドレス */
  email: string;
};

/**
 * .dev.vars の中身から代わりの物の設定を読む。ゲートウェイと同じ値を使うため、値はここにだけ置く
 * @param text .dev.vars の中身
 * @returns ポート、チーム名、宛先、メールアドレス
 * @throws Error 要る値が無い時
 */
export function parseDevVars(text: string): DevVars {
  const vars = new Map(
    text
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()] as const),
  );
  const need = (name: string) => {
    const value = vars.get(name);
    if (!value) throw new Error(`.dev.vars に ${name} が無い`);
    return value;
  };
  return { port: Number(new URL(need("DEV_FAKES_URL")).port), team: need("ACCESS_TEAM"), aud: need("ACCESS_AUD"), email: need("OWNER_EMAIL") };
}

/**
 * 開発の時だけ代わりの物を立てるプラグインを作る。どの要求もオーナーとして通るので、vite を外へ開かない
 * @returns vite のプラグイン
 */
export function devFakes(): Plugin {
  return {
    name: "know-office-dev-fakes",
    apply: "serve",
    async configureServer(server) {
      const vars = parseDevVars(readFileSync(join(server.config.root, ".dev.vars"), "utf8"));
      const fakes = await startFakes({ ...vars, clock: systemClock });
      server.httpServer?.once("close", () => fakes.close());
      server.middlewares.use((req, _res, next) => {
        attachAccess(req, fakes.access.sign).then(() => next(), next);
      });
    },
  };
}
