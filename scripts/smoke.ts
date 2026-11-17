// デプロイした先の画面と API が返る事を、Access の作業用の鍵で聞いて確かめる。deploy.yml のデプロイの後と、手元の wrangler dev に向けて走らせる
import { fileURLToPath } from "node:url";

/** 要求を送る関数。テストは決まった返事を返す物を渡す */
export type SmokeFetch = (input: string, init?: RequestInit) => Promise<Response>;

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
 * @returns 返事か、つながらなかった時の文
 */
async function ask(fetch: SmokeFetch, url: URL, headers: Record<string, string>): Promise<Response | string> {
  try {
    return await fetch(url.toString(), { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
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

/**
 * 画面、API、鍵の無い要求の 3 つを確かめる
 * @param target 確かめる先と鍵
 * @param fetch 要求を送る関数
 * @returns 確かめの結果の並び
 */
async function runChecks(target: Target, fetch: SmokeFetch): Promise<Check[]> {
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
  return checks;
}

/**
 * 環境変数の宛先を確かめ、結果を 1 行ずつ出す
 * @param env 環境変数
 * @param fetch 要求を送る関数
 * @param write 1 行を出す関数
 * @returns 終わりのコード。宛先が無い時は手元なら 0、CI なら 1
 */
export async function runSmokeCli(env: Readonly<Record<string, string | undefined>>, fetch: SmokeFetch, write: (line: string) => void): Promise<number> {
  const target = readTarget(env);
  if (!("base" in target)) {
    write(target.message);
    return target.code;
  }
  write(`確かめる先: ${target.base.origin}`);
  const checks = await runChecks(target, fetch);
  for (const check of checks) write(`${check.ok ? "ok  " : "FAIL"} ${check.name} (${check.detail})`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSmokeCli(process.env, (input, init) => fetch(input, init), (line) => process.stdout.write(`${line}\n`));
}
