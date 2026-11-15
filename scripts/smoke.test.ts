// smoke.ts の、デプロイした先の画面と API が返る事の確かめを、決まった返事を返す fetch で確かめる
// node:test の describe と it は Promise を返すが、node:test が待つので void で示す
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runSmokeCli, type SmokeFetch } from "./smoke.ts";

const BASE = "https://know-office.example.workers.dev";
const ID = "smoke-client.access";
const SECRET = "smoke-secret-0123456789abcdef";
const KEYS = { SMOKE_URL: BASE, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET };

/** 届いた要求の記録 */
type Seen = { url: string; headers: Headers; redirect: RequestInit["redirect"]; signal: boolean };

/**
 * Access の後ろの know-office の代わりを作る。鍵が合えば画面と稼働確認を返し、合わなければ Access のログインへ送る
 * @param change 返事を差し替える関数。無ければ正しい返事
 * @returns fetch と、届いた要求の並び
 */
function deployed(change?: (url: string, authed: boolean) => Response | undefined): { fetch: SmokeFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: SmokeFetch = (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: input, headers, redirect: init?.redirect, signal: init?.signal instanceof AbortSignal });
    const authed = headers.get("CF-Access-Client-Id") === ID && headers.get("CF-Access-Client-Secret") === SECRET;
    const changed = change?.(input, authed);
    if (changed) return Promise.resolve(changed);
    if (!authed) return Promise.resolve(new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } }));
    if (input === `${BASE}/`) {
      return Promise.resolve(new Response('<!doctype html><html lang="ja"><body><div id="root"></div></body></html>', { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    }
    if (input === `${BASE}/api/v1/health`) {
      return Promise.resolve(Response.json({ data: { ok: true, part: "gate" }, meta: { traceId: "t" } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch, seen };
}

/**
 * 確かめを走らせ、出した文と終わりのコードを返す
 * @param env 環境変数
 * @param fetch 要求を送る関数
 * @returns 出した文と終わりのコード
 */
async function run(env: Record<string, string | undefined>, fetch: SmokeFetch): Promise<{ text: string; code: number }> {
  const lines: string[] = [];
  const code = await runSmokeCli(env, fetch, (line) => lines.push(line));
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
    assert.deepEqual(
      seen.map((s) => [s.url, s.headers.has("CF-Access-Client-Secret")]),
      [
        [`${BASE}/`, true],
        [`${BASE}/api/v1/health`, true],
        [`${BASE}/api/v1/health`, false],
      ],
    );
    // 転送を追うと鍵を別の宛先へ送りうるので追わない。どの要求も時間で切る
    assert.ok(seen.every((s) => s.redirect === "manual" && s.signal));
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
