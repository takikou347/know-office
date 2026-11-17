// デプロイした先の画面と API が返る事を、Access の作業用の鍵で聞いて確かめる。deploy.yml のデプロイの後と、手元の wrangler dev に向けて走らせる
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 要求を送る関数。テストは決まった返事を返す物を渡す */
export type SmokeFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 鍵を付けずに聞くルート。パスの変数は埋めてある */
export type SmokeRoute = { method: string; path: string };

/** 1 つの確かめの結果 */
type Check = { name: string; ok: boolean; detail: string };

/** 確かめる先と、Access の作業用の鍵 */
type Target = { base: URL; clientId: string; clientSecret: string };

// 外への要求の初期値 (コードの書き方の「外を呼ぶ時は AbortSignal.timeout()」)
const TIMEOUT_MS = 10_000;
// 鍵を平文で送ってよいのは手元だけ
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 環境変数から確かめる先を読む
 * @param env 環境変数。SMOKE_URL、CF_ACCESS_CLIENT_ID、CF_ACCESS_CLIENT_SECRET、CI
 * @returns 確かめる先か、確かめずに終える時の文と終わりのコード
 */
function readTarget(env: Readonly<Record<string, string | undefined>>): Target | { message: string; code: number } {
  const url = env["SMOKE_URL"] ?? "";
  if (url === "") {
    // 手元と、Cloudflare の鍵がまだ無い間は落とさずに終える。CI ではデプロイの後にしか走らせないので、宛先が無いのは設定の誤り
    const ci = env["CI"] === "true";
    return { message: `宛先が無い: SMOKE_URL にデプロイした先の URL を渡すと確かめる${ci ? "。CI では落とす" : ""}`, code: ci ? 1 : 0 };
  }
  let base: URL;
  try {
    base = new URL("/", url);
  } catch {
    return { message: "SMOKE_URL が URL の形でない", code: 1 };
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOCAL_HOSTS.has(base.hostname))) {
    return { message: "SMOKE_URL は https か手元の http にする。鍵を平文で送らない", code: 1 };
  }
  const missing = ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) return { message: `Access の作業用の鍵が無い: ${missing.join("、")}`, code: 1 };
  return { base, clientId: env["CF_ACCESS_CLIENT_ID"] ?? "", clientSecret: env["CF_ACCESS_CLIENT_SECRET"] ?? "" };
}

/**
 * 1 つの道に聞く。転送は追わない。追うと鍵を別の宛先へ送りうるうえ、Access のログインへの転送を通ったと見誤る
 * @param fetch 要求を送る関数
 * @param url 聞く URL
 * @param headers 付けるヘッダー
 * @param init メソッドと本文。無ければ GET
 * @returns 返事か、つながらなかった時の文
 */
async function ask(fetch: SmokeFetch, url: URL, headers: Record<string, string>, init: { method?: string; body?: string } = {}): Promise<Response | string> {
  try {
    return await fetch(url.toString(), { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    // 失敗の文には鍵が入りうるので、名前だけを出す
    return `つながらない (${error instanceof Error ? error.name : "unknown"})`;
  }
}

/**
 * 本文を読む。読めなければ空にする
 * @param res 返事
 * @returns 本文
 */
async function text(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * 稼働確認の本文から、ゲートウェイの足りない設定の名前を読む
 * @param body 本文
 * @returns 名前の並び。読めなければ空
 */
function missingOf(body: string): string[] {
  try {
    const value: unknown = JSON.parse(body);
    const data: unknown = typeof value === "object" && value !== null && "data" in value ? value.data : null;
    const missing: unknown = typeof data === "object" && data !== null && "missing" in data ? data.missing : null;
    return Array.isArray(missing) ? missing.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 稼働確認の本文が know-office のゲートウェイの物かを見る
 * @param body 本文
 * @returns `{ data: { ok: true, part: "gate" } }` の形なら true
 */
function isGateHealth(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || !("data" in value)) return false;
    const data: unknown = value.data;
    return typeof data === "object" && data !== null && "ok" in data && data.ok === true && "part" in data && data.part === "gate";
  } catch {
    return false;
  }
}

// パスの変数に入れる値。形は UUID v7 で、どの物にも当たらない
const SAMPLE_ID = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const METHOD = /^ {4}(get|post|put|patch|delete):$/;

/**
 * v1.yaml から、ゲートウェイが外へ開くルート (/api/ と /ws/) を読む。Access の Bypass の通知の道 (/hooks/) と、コンテナの中のワークスペースのルート (/v1/) は入れない
 * @param yaml v1.yaml の中身
 * @returns パスの変数を埋めたルートの並び
 */
export function gatewayRoutes(yaml: string): SmokeRoute[] {
  const routes: SmokeRoute[] = [];
  let path: string | null = null;
  for (const line of yaml.split("\n")) {
    // paths の下のキーは 2 字下げ。ほかの 2 字下げのキー (components の下など) や 0 字下げのキーでルートを閉じる
    const key = /^ {0,2}(\S.*):$/.exec(line);
    if (key) {
      const name = key[1] ?? "";
      path = line.startsWith("  ") && (name.startsWith("/api/") || name.startsWith("/ws/")) ? name : null;
      continue;
    }
    const method = METHOD.exec(line)?.[1];
    if (path !== null && method !== undefined) routes.push({ method: method.toUpperCase(), path: path.replaceAll(/\{\w+\}/g, SAMPLE_ID) });
  }
  return routes;
}

/**
 * 返事がゲートウェイの物か (Access に止められていないか) を見る
 * @param res 返事
 * @returns 2xx か、ゲートウェイの JSON (problem+json を含む) なら true
 */
function fromGate(res: Response): boolean {
  const type = res.headers.get("Content-Type") ?? "";
  return (res.status >= 200 && res.status < 300) || type.startsWith("application/problem+json") || type.startsWith("application/json");
}

/**
 * 画面、API、鍵の無い要求、GitHub の通知の道、全部のルートが Access の後ろかの 5 つを確かめる
 * @param target 確かめる先と鍵
 * @param fetch 要求を送る関数
 * @param routes 鍵を付けずに聞くルート
 * @returns 確かめの結果の並び
 */
async function runChecks(target: Target, fetch: SmokeFetch, routes: SmokeRoute[]): Promise<Check[]> {
  // Access の作業用の鍵 (サービストークン) のヘッダー。Access が証明に替えてゲートウェイへ渡す
  const keys = { "CF-Access-Client-Id": target.clientId, "CF-Access-Client-Secret": target.clientSecret };
  const health = new URL("/api/v1/health", target.base);
  const checks: Check[] = [];

  const screen = await ask(fetch, target.base, keys);
  if (typeof screen === "string") checks.push({ name: "画面", ok: false, detail: screen });
  else {
    const body = await text(screen);
    const html = (screen.headers.get("Content-Type") ?? "").startsWith("text/html") && body.includes('<div id="root"></div>');
    checks.push({ name: "画面", ok: screen.status === 200 && html, detail: `${screen.status}${html ? "" : " index.html でない"}` });
  }

  const api = await ask(fetch, health, keys);
  if (typeof api === "string") checks.push({ name: "API", ok: false, detail: api });
  else {
    const body = await text(api);
    const ok = api.status === 200 && isGateHealth(body);
    const missing = missingOf(body);
    const why = missing.length > 0 ? ` 足りない設定: ${missing.join("、")}` : " 稼働確認の形でない";
    checks.push({ name: "API", ok, detail: `${api.status}${ok || api.status !== 200 ? "" : why}` });
  }

  // 鍵の無い要求は Access が止め (ログインへの転送か 403)、ゲートウェイの稼働確認に届かない。手元ではゲートウェイが 401 で断る
  const bare = await ask(fetch, health, {});
  if (typeof bare === "string") checks.push({ name: "鍵の無い要求", ok: false, detail: bare });
  else {
    const reached = bare.status === 200 || isGateHealth(await text(bare));
    checks.push({ name: "鍵の無い要求", ok: !reached, detail: `${bare.status}${reached ? " 稼働確認に届いた" : ""}` });
  }

  // GitHub の通知の道だけは Access の Bypass でゲートウェイに届き、署名の無い通知を 401 の problem+json で断る。Access に止められると転送か HTML になる
  const hook = await ask(fetch, new URL("/hooks/v1/github", target.base), { "Content-Type": "application/json", "X-GitHub-Event": "ping" }, { method: "POST", body: "{}" });
  if (typeof hook === "string") checks.push({ name: "GitHub の通知の道", ok: false, detail: hook });
  else {
    await text(hook);
    const gate = hook.status === 401 && (hook.headers.get("Content-Type") ?? "").startsWith("application/problem+json");
    checks.push({ name: "GitHub の通知の道", ok: gate, detail: `${hook.status}${gate ? "" : " ゲートウェイに届かない (Access の Bypass を確かめる)"}` });
  }

  checks.push(await accessCovers(target, fetch, routes));
  return checks;
}

/**
 * 鍵を付けずに v1.yaml の全部のルートへ悪い要求 (ほかのサイトからの書き込み、壊れた本文) を送り、どれも Access に止まってゲートウェイに届かない事を見る。
 * 届いた先の守りは画面の通しの e2e/attack.spec.ts が同じコードで確かめるので、デプロイした先では Access の道の誤りだけを見る
 * @param target 確かめる先
 * @param fetch 要求を送る関数
 * @param routes 聞くルート
 * @returns 確かめの結果
 */
async function accessCovers(target: Target, fetch: SmokeFetch, routes: SmokeRoute[]): Promise<Check> {
  const name = "全部のルートが Access の後ろ";
  // 手元の wrangler dev には Access が無く、ゲートウェイが 401 で断る
  if (target.base.protocol === "http:") return { name, ok: true, detail: "手元は見ない" };
  if (routes.length === 0) return { name, ok: false, detail: "v1.yaml からルートを読めない" };
  const reached: string[] = [];
  // Access に止まった要求はゲートウェイの 1 分 300 回の制限に数えないので、1 本ずつ順に送る
  for (const route of routes) {
    const write = route.method !== "GET";
    const res = await ask(fetch, new URL(route.path, target.base), write ? { Origin: "https://evil.example", "Content-Type": "application/json" } : {}, write ? { method: route.method, body: '{"unknown":' } : {});
    if (typeof res === "string") reached.push(`${route.method} ${route.path} ${res}`);
    else {
      await text(res);
      if (fromGate(res)) reached.push(`${route.method} ${route.path} ${res.status}`);
    }
  }
  return { name, ok: reached.length === 0, detail: reached.length === 0 ? `${routes.length} 本` : `ゲートウェイに届いた: ${reached.slice(0, 5).join("、")}` };
}

/**
 * v1.yaml からゲートウェイのルートを読む
 * @returns ルートの並び
 */
function routesOfV1(): SmokeRoute[] {
  return gatewayRoutes(readFileSync(new URL("../apps/office/openapi/v1.yaml", import.meta.url), "utf8"));
}

/**
 * 環境変数の宛先を確かめ、結果を 1 行ずつ出す
 * @param env 環境変数
 * @param fetch 要求を送る関数
 * @param write 1 行を出す関数
 * @param routes 鍵を付けずに聞くルート。初期値は v1.yaml の全部
 * @returns 終わりのコード。宛先が無い時は手元なら 0、CI なら 1
 */
export async function runSmokeCli(env: Readonly<Record<string, string | undefined>>, fetch: SmokeFetch, write: (line: string) => void, routes: SmokeRoute[] = routesOfV1()): Promise<number> {
  const target = readTarget(env);
  if (!("base" in target)) {
    write(target.message);
    return target.code;
  }
  write(`確かめる先: ${target.base.origin}`);
  const checks = await runChecks(target, fetch, routes);
  for (const check of checks) write(`${check.ok ? "ok  " : "FAIL"} ${check.name} (${check.detail})`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSmokeCli(process.env, (input, init) => fetch(input, init), (line) => process.stdout.write(`${line}\n`));
}
