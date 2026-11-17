// smoke.ts の、デプロイした先の画面と API が返る事の確かめを、決まった返事を返す fetch で確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { gatewayRoutes, runSmokeCli, type SmokeFetch, type SmokeRoute } from "./smoke.ts";

const BASE = "https://know-office.example.workers.dev";
const ID = "smoke-client.access";
const SECRET = "smoke-secret-0123456789abcdef";
const KEYS = { SMOKE_URL: BASE, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET };
/** 確かめるルートの見本。v1.yaml の全部は gatewayRoutes のテストで読む */
const ROUTES: SmokeRoute[] = [
  { method: "GET", path: "/api/v1/me" },
  { method: "POST", path: "/api/v1/staff/builder/stop" },
];

/** 届いた要求の記録 */
type Seen = { url: string; headers: Headers; redirect: RequestInit["redirect"]; signal: boolean; method: string };

/**
 * Access の後ろの know-office の代わりを作る。鍵が合えば画面と稼働確認を返し、合わなければ Access のログインへ送る。
 * GitHub の通知の道だけは Access の Bypass を通ってゲートウェイに届き、署名の無い通知を 401 の problem+json で断る
 * @param change 返事を差し替える関数。無ければ正しい返事
 * @returns fetch と、届いた要求の並び
 */
function deployed(change?: (url: string, authed: boolean) => Response | undefined): { fetch: SmokeFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: SmokeFetch = (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: input, headers, redirect: init?.redirect, signal: init?.signal instanceof AbortSignal, method: init?.method ?? "GET" });
    const authed = headers.get("CF-Access-Client-Id") === ID && headers.get("CF-Access-Client-Secret") === SECRET;
    const changed = change?.(input, authed);
    if (changed) return Promise.resolve(changed);
    if (input === `${BASE}/hooks/v1/github`) {
      return Promise.resolve(Response.json({ status: 401, code: "unauthenticated" }, { status: 401, headers: { "Content-Type": "application/problem+json" } }));
    }
    if (!authed) return Promise.resolve(new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } }));
    if (input === `${BASE}/`) {
      return Promise.resolve(new Response('<!doctype html><html lang="ja"><body><div id="root"></div></body></html>', { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }
    if (input === `${BASE}/api/v1/health`) {
      return Promise.resolve(Response.json({ data: { ok: true, part: "gate", missing: [] }, meta: { traceId: "t" } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch, seen };
}

/**
 * 確かめを走らせ、出した文と終わりのコードを返す
 * @param env 環境変数
 * @param fetch 要求を送る関数
 * @param routes 鍵を付けずに聞くルート
 * @returns 出した文と終わりのコード
 */
async function run(env: Record<string, string | undefined>, fetch: SmokeFetch, routes: SmokeRoute[] = ROUTES): Promise<{ text: string; code: number }> {
  const lines: string[] = [];
  const code = await runSmokeCli(env, fetch, (line) => lines.push(line), routes);
  return { text: lines.join("\n"), code };
}

void describe("デプロイした後に画面と API が返る", () => {
  void it("鍵を付けると画面と稼働確認が返り、鍵が無いと稼働確認に届かない", async () => {
    const { fetch, seen } = deployed();
    const { text, code } = await run(KEYS, fetch);
    assert.equal(code, 0, text);
    assert.match(text, /ok {3}画面/);
    assert.match(text, /ok {3}API/);
    assert.match(text, /ok {3}鍵の無い要求/);
    assert.match(text, /ok {3}GitHub の通知の道/);
    assert.match(text, /ok {3}全部のルートが Access の後ろ \(2 本\)/);
    assert.deepEqual(
      seen.map((s) => [s.method, s.url, s.headers.has("CF-Access-Client-Secret")]),
      [
        ["GET", `${BASE}/`, true],
        ["GET", `${BASE}/api/v1/health`, true],
        ["GET", `${BASE}/api/v1/health`, false],
        ["POST", `${BASE}/hooks/v1/github`, false],
        ["GET", `${BASE}/api/v1/me`, false],
        ["POST", `${BASE}/api/v1/staff/builder/stop`, false],
      ],
    );
    // 転送を追うと鍵を別の宛先へ送りうるので追わない。どの要求も時間で切る
    assert.ok(seen.every((s) => s.redirect === "manual" && s.signal));
  });

  void it("GitHub の通知の道が Access に止められているか、ゲートウェイの断りでなければ落とす", async () => {
    // Bypass が無いと、Access は鍵の無い要求をログインへ送るか 403 の HTML を返す
    // 401 でも problem+json でなければ、ゲートウェイの断りでない
    const blockedAll = [
      new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/" } }),
      new Response("<html>Forbidden</html>", { status: 403, headers: { "Content-Type": "text/html" } }),
      new Response("<html>Unauthorized</html>", { status: 401, headers: { "Content-Type": "text/html" } }),
    ];
    for (const blocked of blockedAll) {
      const { fetch } = deployed((url) => (url === `${BASE}/hooks/v1/github` ? blocked : undefined));
      const { text, code } = await run(KEYS, fetch);
      assert.equal(code, 1, text);
      assert.match(text, /FAIL GitHub の通知の道/);
    }
  });

  void it("鍵の無い要求がゲートウェイに届くルートがあれば、そのルートを出して落とす", async () => {
    // Access のアプリの道が狭いと、鍵の無い要求がゲートウェイに届き、ゲートウェイの problem+json が返る
    const leak = deployed((url, authed) => (!authed && url === `${BASE}/api/v1/me` ? Response.json({ status: 401, code: "unauthenticated" }, { status: 401, headers: { "Content-Type": "application/problem+json" } }) : undefined));
    const { text, code } = await run(KEYS, leak.fetch);
    assert.equal(code, 1, text);
    assert.match(text, /FAIL 全部のルートが Access の後ろ .*GET \/api\/v1\/me/);
    assert.doesNotMatch(text, /stop/);
    // 確かめるルートが無いのは v1.yaml の読み違いなので落とす
    const empty = await run(KEYS, deployed().fetch, []);
    assert.equal(empty.code, 1, empty.text);
  });

  void it("v1.yaml から、ゲートウェイの外向きのルートを、変数を埋めて全部読む", () => {
    const routes = gatewayRoutes(readFileSync(new URL("../apps/office/openapi/v1.yaml", import.meta.url), "utf8"));
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    assert.ok(routes.length > 50, String(routes.length));
    assert.ok(keys.has("GET /api/v1/me"));
    assert.ok(routes.some((r) => r.path.startsWith("/ws/v1/")));
    // Bypass の通知の道と、コンテナの中のワークスペースのルート (/v1/) は入れない
    assert.ok(routes.every((r) => r.path.startsWith("/api/") || r.path.startsWith("/ws/")));
    assert.ok(routes.every((r) => !r.path.includes("{")));
  });

  void it("手元の宛先には Access が無いので、ルートの確かめは飛ばす", async () => {
    const local = deployed((url, authed) => (authed ? undefined : new Response(null, { status: 401 })));
    const { text } = await run({ ...KEYS, SMOKE_URL: "http://localhost:8787" }, local.fetch);
    assert.match(text, /ok {3}全部のルートが Access の後ろ \(手元は見ない\)/);
    assert.ok(!local.seen.some((s) => s.url.endsWith("/api/v1/me")));
  });

  void it("宛先の末尾の / と道は無視して入口から聞く", async () => {
    const { fetch, seen } = deployed();
    const { code } = await run({ ...KEYS, SMOKE_URL: `${BASE}/dashboard/` }, fetch);
    assert.equal(code, 0);
    assert.equal(seen[0]?.url, `${BASE}/`);
  });

  void it("宛先が無い時は、宛先が無いと出して落とさず終える", async () => {
    const { fetch, seen } = deployed();
    const { text, code } = await run({ CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET }, fetch);
    assert.equal(code, 0);
    assert.match(text, /^宛先が無い/);
    assert.equal(seen.length, 0);
  });

  void it("CI で宛先が無い時は落とす", async () => {
    const { fetch } = deployed();
    const { text, code } = await run({ CI: "true", SMOKE_URL: "" }, fetch);
    assert.equal(code, 1);
    assert.match(text, /^宛先が無い/);
  });

  void it("宛先はあるのに鍵が無い時は聞かずに落とす", async () => {
    const { fetch, seen } = deployed();
    const { text, code } = await run({ SMOKE_URL: BASE, CF_ACCESS_CLIENT_ID: ID }, fetch);
    assert.equal(code, 1);
    assert.match(text, /CF_ACCESS_CLIENT_SECRET/);
    assert.equal(seen.length, 0);
  });

  void it("https でない宛先には手元のほか鍵を送らない", async () => {
    const { fetch, seen } = deployed();
    const { code } = await run({ ...KEYS, SMOKE_URL: "http://know-office.example.workers.dev" }, fetch);
    assert.equal(code, 1);
    assert.equal(seen.length, 0);
    const local = deployed((url, authed) => (authed ? undefined : new Response(null, { status: 401 })));
    await run({ ...KEYS, SMOKE_URL: "http://localhost:8787" }, local.fetch);
    assert.equal(local.seen[0]?.url, "http://localhost:8787/");
  });

  void it("形の違う宛先は聞かずに落とす", async () => {
    const { fetch, seen } = deployed();
    const { code } = await run({ ...KEYS, SMOKE_URL: "know-office" }, fetch);
    assert.equal(code, 1);
    assert.equal(seen.length, 0);
  });

  void it("稼働確認が 503 なら落とす", async () => {
    const { fetch } = deployed((url, authed) => (authed && url.endsWith("/api/v1/health") ? new Response("{}", { status: 503 }) : undefined));
    const { text, code } = await run(KEYS, fetch);
    assert.equal(code, 1);
    assert.match(text, /FAIL API .*503/);
  });

  void it("鍵を付けても Access のログインへ送られたら落とす", async () => {
    const { fetch } = deployed((url) => (url === `${BASE}/` ? new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/" } }) : undefined));
    const { text, code } = await run(KEYS, fetch);
    assert.equal(code, 1);
    assert.match(text, /FAIL 画面 .*302/);
  });

  void it("画面が index.html でなければ落とす", async () => {
    const { fetch } = deployed((url, authed) => (authed && url === `${BASE}/` ? new Response("<html></html>", { headers: { "Content-Type": "text/html" } }) : undefined));
    const { code } = await run(KEYS, fetch);
    assert.equal(code, 1);
  });

  void it("稼働確認の形が違えば落とす", async () => {
    const { fetch } = deployed((url, authed) => (authed && url.endsWith("/api/v1/health") ? Response.json({ data: { ok: false, part: "gate" } }) : undefined));
    const { code } = await run(KEYS, fetch);
    assert.equal(code, 1);
  });

  void it("稼働確認が足りない設定を返したら、その名前を出して落とす", async () => {
    const { fetch } = deployed((url, authed) => (authed && url.endsWith("/api/v1/health") ? Response.json({ data: { ok: false, part: "gate", missing: ["ANTHROPIC_API_KEY", "MASTER_KEY"] } }) : undefined));
    const { text, code } = await run(KEYS, fetch);
    assert.equal(code, 1);
    assert.match(text, /FAIL API .*足りない設定: ANTHROPIC_API_KEY、MASTER_KEY/);
  });

  void it("鍵の無い要求が稼働確認に届いたら落とす", async () => {
    const { fetch } = deployed((url, authed) => (!authed && url.endsWith("/api/v1/health") ? Response.json({ data: { ok: true, part: "gate" } }) : undefined));
    const { text, code } = await run(KEYS, fetch);
    assert.equal(code, 1);
    assert.match(text, /FAIL 鍵の無い要求/);
  });

  void it("つながらない時は落とし、鍵を出さない", async () => {
    const fetch: SmokeFetch = () => Promise.reject(new Error(`connect failed ${SECRET}`));
    const { text, code } = await run(KEYS, fetch);
    assert.equal(code, 1);
    assert.ok(!text.includes(SECRET), text);
    assert.ok(!text.includes(ID), text);
  });
});
