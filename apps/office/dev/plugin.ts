// 開発用の vite のプラグイン。代わりの物を立て、API への要求に代わりの Access の証明を付け、ログインセッションのクッキーを http で使える名前にする。ログインと記録の 3.9
import { readFileSync } from "node:fs";
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { join } from "node:path";
import { systemClock } from "@know-office/core";
import type { Plugin } from "vite";
import { SESSION_COOKIE } from "../src/gate/auth/session.ts";
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

/** 開発の入口でブラウザーに渡す、ログインセッションのクッキーの名前。__Host- は Secure が要るので付けない */
const DEV_SESSION_COOKIE = "ko_session";

/**
 * ゲートウェイが返した Set-Cookie の 1 つを、Secure の無い開発の名前にする。ほかのクッキーは変えない
 * @param value Set-Cookie の値
 * @returns ブラウザーに渡す値
 */
function toDevSetCookie(value: string): string {
  if (!value.startsWith(`${SESSION_COOKIE}=`)) return value;
  const [pair = "", ...attrs] = value.split(";").map((part) => part.trim());
  return [`${DEV_SESSION_COOKIE}${pair.slice(SESSION_COOKIE.length)}`, ...attrs.filter((a) => a.toLowerCase() !== "secure")].join("; ");
}

/**
 * Set-Cookie のヘッダーの値 (1 つか並び) を開発の名前にする
 * @param value ヘッダーの値
 * @returns 直した値
 */
function devSetCookies<T extends OutgoingHttpHeader | readonly string[]>(value: T): T | string | string[] {
  if (typeof value === "string") return toDevSetCookie(value);
  if (typeof value === "number") return value;
  return value.map(toDevSetCookie);
}

/**
 * writeHead に渡されたヘッダー (オブジェクトか、名前と値を交互に並べた配列) の Set-Cookie を直す
 * @param headers writeHead のヘッダー
 * @returns 直したヘッダー
 */
function devHeaders(headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined): OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined {
  if (Array.isArray(headers)) return headers.map((v, i) => (i % 2 === 1 && String(headers[i - 1]).toLowerCase() === "set-cookie" ? devSetCookies(v) : v));
  if (!headers) return headers;
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) out[k] = k.toLowerCase() === "set-cookie" && v !== undefined ? devSetCookies(v) : v;
  return out;
}

/**
 * 開発の入口は http://localhost なので、Secure のクッキーを受けないブラウザー (Linux の WebKit など) がある。API への要求だけ、
 * ログインセッションのクッキーを Secure の無い開発の名前でブラウザーに渡し、受けた時は本物の名前に戻してゲートウェイへ渡す。ゲートウェイは本物と同じ __Host- の名前だけを見る
 * @param req 要求
 * @param res 返事
 */
export function localSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  if (!PROTECTED.test(req.url ?? "")) return;
  const cookie = req.headers.cookie;
  if (cookie) {
    // ブラウザーに本物の名前が残っていても、開発の名前の物だけを使う
    const pairs = cookie.split(";").map((p) => p.trim()).filter((p) => !p.startsWith(`${SESSION_COOKIE}=`));
    req.headers.cookie = pairs.map((p) => (p.startsWith(`${DEV_SESSION_COOKIE}=`) ? `${SESSION_COOKIE}${p.slice(DEV_SESSION_COOKIE.length)}` : p)).join("; ");
  }
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name: string, value: number | string | readonly string[]) => setHeader(name, name.toLowerCase() === "set-cookie" ? devSetCookies(value) : value);
  const appendHeader = res.appendHeader.bind(res);
  res.appendHeader = (name: string, value: string | readonly string[]) => appendHeader(name, name.toLowerCase() === "set-cookie" ? devSetCookies(value) : value);
  const writeHead = res.writeHead.bind(res);
  // writeHead(status, headers) と writeHead(status, statusMessage, headers) の両方を受ける
  res.writeHead = (status: number, a?: string | OutgoingHttpHeaders | OutgoingHttpHeader[], b?: OutgoingHttpHeaders | OutgoingHttpHeader[]) =>
    typeof a === "string" ? writeHead(status, a, devHeaders(b)) : writeHead(status, devHeaders(a));
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
      server.middlewares.use((req, res, next) => {
        localSessionCookie(req, res);
        attachAccess(req, fakes.access.sign).then(() => next(), next);
      });
    },
  };
}
