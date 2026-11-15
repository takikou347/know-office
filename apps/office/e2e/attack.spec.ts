import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { parse } from "yaml";
import { z } from "zod";

// 動く入口への自動の攻撃のチェック。v1.yaml の /api/ の全ルートに悪い要求を送り、決めた 4xx で断り 500 を出さない事を見る
// (セキュリティの「弱点のチェック」、API の決まりの 3.6)。ブラウザーを使わないので、playwright.config.ts の attack のプロジェクトで 1 度だけ流す
const METHODS = ["get", "post", "put", "patch", "delete"];
const v1 = z
  .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .parse(parse(readFileSync(join(import.meta.dirname, "../openapi/v1.yaml"), "utf8")));
const routes = Object.entries(v1.paths)
  .filter(([path]) => path.startsWith("/api/"))
  .flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, body: z.object({ requestBody: z.unknown() }).safeParse(op).success })),
  );
const writes = routes.filter((r) => r.method !== "GET");
/** ログインセッションを確かめないルート。セッションを作る所と稼働確認 */
const WITHOUT_SESSION = new Set(["POST /api/v1/sessions", "GET /api/v1/health"]);

type Route = (typeof routes)[number];
type Attack = { name: string; ip: string; routes: Route[]; allowed: number[]; send: (api: APIRequestContext, route: Route, origin: string) => Promise<number> };

/**
 * パスの変数を埋める
 * @param path v1.yaml の形のパス
 * @param value 入れる値
 * @returns 要求を出すパス
 */
function fill(path: string, value: string): string {
  return path.replaceAll(/\{\w+\}/g, encodeURIComponent(value));
}

/**
 * 要求を出し、状態コードを返す
 * @param api 要求の口
 * @param route ルート
 * @param options ヘッダー、本文、パスの変数の値
 * @returns 状態コード
 */
async function send(api: APIRequestContext, route: Route, options: { headers: Record<string, string>; data?: string; id?: string }): Promise<number> {
  const res = await api.fetch(fill(route.path, options.id ?? "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"), {
    method: route.method,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(options.data === undefined ? {} : { data: options.data }),
    maxRedirects: 0,
  });
  return res.status();
}

const ATTACKS: Attack[] = [
  {
    name: "ログインセッションの無い要求",
    ip: "198.18.0.1",
    routes: routes.filter((r) => !WITHOUT_SESSION.has(r.key)),
    allowed: [401],
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin, Cookie: "" } }),
  },
  {
    name: "壊れたクッキー",
    ip: "198.18.0.2",
    routes: routes.filter((r) => !WITHOUT_SESSION.has(r.key)),
    allowed: [401],
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin, Cookie: "ko_session=%00broken.cookie" } }),
  },
  {
    name: "ほかのサイトからの書き込み",
    ip: "198.18.0.3",
    routes: writes,
    allowed: [403],
    send: (api, route) => send(api, route, { headers: { Origin: "https://evil.example" } }),
  },
  {
    name: "大きすぎる本文",
    ip: "198.18.0.4",
    routes: writes.filter((r) => r.method !== "DELETE"),
    allowed: [413],
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin }, data: "x".repeat(1024 * 1024 + 1) }),
  },
  {
    name: "形の違う ID と壊れた本文",
    ip: "198.18.0.5",
    routes: routes.filter((r) => r.path.includes("{") || r.body),
    // パスキーの確認の要るルートは 401、無いルートは 404
    allowed: [400, 401, 404, 422],
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin }, id: "../x' OR 1=1", ...(route.body ? { data: '{"unknown":' } : {}) }),
  },
];

test.describe("弱点のチェック", () => {
  for (const attack of ATTACKS) {
    test(attack.name, async ({ playwright, baseURL }) => {
      test.setTimeout(60_000);
      const origin = String(baseURL);
      // 送信元ごとに 1 分 300 回なので、攻撃ごとに送信元を変える
      const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { "CF-Connecting-IP": attack.ip } });
      // 攻撃はログインした人のクッキーを持たないものと、持つものがある。持つ側のためにセッションを 1 つ作る
      expect((await api.post("/api/v1/sessions", { headers: { Origin: origin, "Content-Type": "application/json" } })).status()).toBe(201);
      expect((await api.get("/api/v1/me")).status()).toBe(200);
      const bad: string[] = [];
      for (const route of attack.routes) {
        const status = await attack.send(api, route, origin);
        if (!attack.allowed.includes(status)) bad.push(`${route.key}: ${String(status)}`);
      }
      await api.dispose();
      expect(bad).toEqual([]);
    });
  }
});
