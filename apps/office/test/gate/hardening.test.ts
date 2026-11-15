// WAF が無い時の守りを、v1.yaml とコードのルートの一覧から全ルートに当てて確かめる。API の決まりの 3.6
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { MAX_BODY_BYTES } from "../../src/gate/body.ts";
import gate from "../../src/gate/index.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, ORIGIN, type TestGate } from "../helpers/gate.ts";

const MINUTE = 60_000;
const METHODS = ["get", "post", "put", "patch", "delete"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const Operation = z.object({
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  "x-step-up": z.union([z.boolean(), z.string()]).optional(),
  requestBody: z.unknown().optional(),
});
type Operation = z.infer<typeof Operation>;
const v1 = z
  .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .parse(parse(readFileSync(join(import.meta.dirname, "../../openapi/v1.yaml"), "utf8")));

/** v1.yaml の操作を「メソッド パス」ごとに並べる */
const specOps = new Map<string, Operation>(
  Object.entries(v1.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, op]) => (METHODS.includes(method) ? [[`${method.toUpperCase()} ${path}`, Operation.parse(op)] as const] : [])),
  ),
);

/** コードのルート。Hono の `:name` を v1.yaml の `{name}` に直す */
const codeRoutes = [
  ...new Set(gate.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path.replaceAll(/:(\w+)/g, "{$1}")}`)),
].map((key) => {
  const [method = "", path = ""] = key.split(" ");
  return { key, method, path };
});
const writeRoutes = codeRoutes.filter((r) => !SAFE.has(r.method));
/** 本文を受けるメソッドのルート。DELETE は本文を読まない */
const bodyRoutes = codeRoutes.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method));

/**
 * 認証を外してよい操作と、その代わりの守り。ここに足す時は API の決まりの 3.6 の 1 を直してから
 */
const WITHOUT_LOGIN = new Map([
  ["POST /hooks/v1/github", "Access を外す唯一のパス。X-Hub-Signature-256 で確かめる"],
  ["POST /ws/v1/heartbeat", "ワークスペースの出口のプロキシだけが届け、送信元の社員をプロキシが決める"],
  ["POST /ws/v1/checkpoints", "ワークスペースの出口のプロキシだけが届け、送信元の社員をプロキシが決める"],
  ["GET /v1/health", "ワークスペースの中のサーバー。社員 DO からしか届かない"],
]);

/** ログインセッションを確かめないルート。middleware.ts の WITHOUT_SESSION と同じ */
const WITHOUT_SESSION = new Set(["POST /api/v1/sessions", "GET /api/v1/health"]);

/**
 * パスの変数を埋めた URL を作る
 * @param path v1.yaml の形のパス
 * @param value 変数に入れる値
 * @returns 要求を出すパス
 */
function fill(path: string, value = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"): string {
  return path.replaceAll(/\{\w+\}/g, encodeURIComponent(value));
}

let d1: TestD1;
let test: TestGate;
let signedIn: Record<string, string>;
const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));
beforeEach(async () => {
  d1 = await createTestD1();
  test = await createTestGate({ clock, d1 });
  signedIn = await test.signIn();
});
afterEach(() => d1.dispose());

/**
 * 全ルートに同じ悪い要求を出し、ルートごとの状態コードを返す
 * @param routes 要求を出すルート
 * @param init ルートごとの要求の設定
 * @returns 「メソッド パス」から状態コードへの対応
 */
async function statuses(
  routes: typeof codeRoutes,
  init: (route: (typeof codeRoutes)[number]) => { url?: string; headers: Record<string, string>; body?: string },
) {
  const out: Record<string, number> = {};
  for (const [i, route] of routes.entries()) {
    const { url, headers, ...rest } = init(route);
    // ログインの失敗は送信元ごとに 5 回でロックアウトになるので、決めた送信元の無い要求はルートごとに送信元を変える
    const from = { "CF-Connecting-IP": `198.51.100.${String(i + 1)}`, ...headers };
    const res = await test.request(url ?? fill(route.path), { method: route.method, headers: from, ...rest });
    out[route.key] = res.status;
  }
  return out;
}

/**
 * v1.yaml でその操作が本文を受けるかを返す
 * @param key 「メソッド パス」
 * @returns 本文を受ければ true
 */
function takesBody(key: string): boolean {
  return specOps.get(key)?.requestBody !== undefined;
}

/**
 * ルートの並びを、どれも同じ状態コードの対応にする
 * @param routes ルート
 * @param status 期待する状態コード
 * @returns 「メソッド パス」から状態コードへの対応
 */
function every(routes: typeof codeRoutes, status: number): Record<string, number> {
  return Object.fromEntries(routes.map((r) => [r.key, status]));
}

describe("WAF が無い時の守り", () => {
  it("v1.yaml で認証を外す操作は、GitHub の通知とワークスペースの内側の決めた物だけ", () => {
    const open = [...specOps].filter(([, op]) => Array.isArray(op.security) && op.security.length === 0).map(([key]) => key);
    expect(open.toSorted()).toEqual([...WITHOUT_LOGIN.keys()].toSorted());
  });

  it("コードのルートはどれも v1.yaml でログインを求め、入口のミドルウェアが掛かる /api/ の下にある", () => {
    expect(codeRoutes.length).toBeGreaterThan(0);
    expect(codeRoutes.filter((r) => !r.path.startsWith("/api/")).map((r) => r.key)).toEqual([]);
    const withoutLogin = codeRoutes.filter((r) => {
      const security = specOps.get(r.key)?.security;
      return !Array.isArray(security) || !JSON.stringify(security).includes("accessJwt");
    });
    expect(withoutLogin.map((r) => r.key)).toEqual([]);
  });

  it("どのルートも、ログインの証明の無い要求を 401 で断る", async () => {
    expect(await statuses(codeRoutes, () => ({ headers: { Origin: ORIGIN } }))).toEqual(every(codeRoutes, 401));
  });

  it("どのルートも、壊れたクッキーを 401 で断る", async () => {
    const routes = codeRoutes.filter((r) => !WITHOUT_SESSION.has(r.key));
    const proof = signedIn["Cf-Access-Jwt-Assertion"] ?? "";
    const result = await statuses(routes, () => ({
      headers: { "Cf-Access-Jwt-Assertion": proof, Cookie: "__Host-ko_session=broken.%00.cookie", Origin: ORIGIN },
    }));
    expect(result).toEqual(every(routes, 401));
  });

  it("書き込みのルートはどれも、Origin が違うか無ければ 403 で断る", async () => {
    const other = await statuses(writeRoutes, () => ({ headers: { ...signedIn, Origin: "https://evil.example" } }));
    expect(other).toEqual(every(writeRoutes, 403));
    const none = await statuses(writeRoutes, () => {
      const { Origin: _, ...headers } = signedIn;
      return { headers };
    });
    expect(none).toEqual(every(writeRoutes, 403));
  });

  it("書き込みのルートはどれも、送信元の 1 分の数を超えると 429 で断る", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 300; i += 1) await test.guard.admit(ip, "api", clock.now());
    for (let i = 0; i < 10; i += 1) await test.guard.admit(ip, "auth", clock.now());
    const result = await statuses(writeRoutes, () => ({ headers: { ...signedIn, "CF-Connecting-IP": ip } }));
    expect(result).toEqual(every(writeRoutes, 429));
  });

  it("x-step-up が true のルートはどれも、入力を確かめる前にパスキーの確認を求める", async () => {
    const routes = codeRoutes.filter((r) => specOps.get(r.key)?.["x-step-up"] === true);
    expect(routes.length).toBeGreaterThan(0);
    // 形の違う ID と本文でも、確認の無い人には 422 でなく 401 を返し、入力の形を探らせない
    const result = await statuses(routes, (r) => ({
      url: `${fill(r.path, "not-an-id")}?unknown=1`,
      headers: { ...signedIn, "Content-Type": "application/json" },
      ...(SAFE.has(r.method) ? {} : { body: "{\"unknown\":" }),
    }));
    expect(result).toEqual(every(routes, 401));
  });

  it("どの書き込みのルートも、1MB を超える本文を 413 で断る", async () => {
    const body = "x".repeat(MAX_BODY_BYTES + 1);
    const result = await statuses(bodyRoutes, () => ({ headers: { ...signedIn, "Content-Type": "application/json" }, body }));
    expect(result).toEqual(every(bodyRoutes, 413));
  });

  it("どのルートも、形の違う ID と壊れた本文で 500 を出さず、4xx で断る", async () => {
    await d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(clock.now() + 15 * MINUTE).run();
    // 変数も本文も持たないルート (ログインセッションの開始と終わりなど) は、壊す入力が無いので除く
    const routes = codeRoutes.filter((r) => r.path.includes("{") || takesBody(r.key));
    const result = await statuses(routes, (r) => ({
      url: fill(r.path, "../x' OR 1=1"),
      headers: { ...signedIn, "Content-Type": "application/json" },
      ...(takesBody(r.key) ? { body: "{\"unknown\":" } : {}),
    }));
    const bad = Object.entries(result).filter(([, status]) => ![400, 404, 409, 422].includes(status));
    expect(bad).toEqual([]);
  });
});
