// 動く入口への自動の攻撃のチェック。v1.yaml の /api/ の全ルートに悪い要求を送り、決めた 4xx で断り 500 を出さない事を見る (セキュリティの「弱点のチェック」、API の決まりの 3.6)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { parse } from "yaml";
import { z } from "zod";
import { STEP_UP_NOT_BUILT } from "../test/helpers/step-up.ts";

// ブラウザーを使わないので、playwright.config.ts の attack のプロジェクトで 1 度だけ流す
const METHODS = ["get", "post", "put", "patch", "delete"];
const Operation = z.object({ requestBody: z.unknown().optional(), "x-step-up": z.union([z.boolean(), z.string()]).optional() });
const v1 = z
  .object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) })
  .parse(parse(readFileSync(join(import.meta.dirname, "../openapi/v1.yaml"), "utf8")));
const routes = Object.entries(v1.paths)
  .filter(([path]) => path.startsWith("/api/"))
  .flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, raw]) => {
        const op = Operation.parse(raw);
        return { key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, body: op.requestBody !== undefined, stepUp: op["x-step-up"] === true };
      }),
  );
const writes = routes.filter((r) => r.method !== "GET");
/** ログインセッションを確かめないルート。セッションを作る所と稼働確認 */
const WITHOUT_SESSION = new Set(["POST /api/v1/sessions", "GET /api/v1/health"]);

type Route = (typeof routes)[number];
/** 1 つの要求の答え。状態コードと、problem+json の code (無ければ空) */
type Answer = { status: number; code: string };
type Attack = { name: string; ip: string; routes: Route[]; allowed: (answer: Answer) => boolean; send: (api: APIRequestContext, route: Route, origin: string) => Promise<Answer> };

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
 * 要求を出し、状態コードと problem+json の code を返す
 * @param api 要求の口
 * @param route ルート
 * @param options ヘッダー、本文、パスの変数の値
 * @returns 答え
 */
async function send(api: APIRequestContext, route: Route, options: { headers: Record<string, string>; data?: string; id?: string }): Promise<Answer> {
  const res = await api.fetch(fill(route.path, options.id ?? "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"), {
    method: route.method,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(options.data === undefined ? {} : { data: options.data }),
    maxRedirects: 0,
  });
  const problem = z.object({ code: z.string() }).loose().safeParse(await res.json().catch(() => null));
  return { status: res.status(), code: problem.success ? problem.data.code : "" };
}

/**
 * 決めた状態コードのどれかなら通す
 * @param statuses 通す状態コード
 * @returns 答えを見る関数
 */
const statusIn = (...statuses: number[]) => (answer: Answer) => statuses.includes(answer.status);

const ATTACKS: Attack[] = [
  {
    name: "ログインセッションの無い要求",
    ip: "198.18.0.1",
    routes: routes.filter((r) => !WITHOUT_SESSION.has(r.key)),
    allowed: statusIn(401),
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin, Cookie: "" } }),
  },
  {
    name: "壊れたクッキー",
    ip: "198.18.0.2",
    routes: routes.filter((r) => !WITHOUT_SESSION.has(r.key)),
    allowed: statusIn(401),
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin, Cookie: "ko_session=%00broken.cookie" } }),
  },
  {
    name: "ほかのサイトからの書き込み",
    ip: "198.18.0.3",
    routes: writes,
    allowed: statusIn(403),
    send: (api, route) => send(api, route, { headers: { Origin: "https://evil.example" } }),
  },
  {
    name: "大きすぎる本文",
    ip: "198.18.0.4",
    routes: writes.filter((r) => r.method !== "DELETE"),
    allowed: statusIn(413),
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin }, data: "x".repeat(1024 * 1024 + 1) }),
  },
  {
    name: "形の違う ID と壊れた本文",
    ip: "198.18.0.5",
    routes: routes.filter((r) => r.path.includes("{") || r.body),
    // パスキーの確認の要るルートは 401、無いルートは 404
    allowed: statusIn(400, 401, 404, 422),
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin }, id: "../x' OR 1=1", ...(route.body ? { data: '{"unknown":' } : {}) }),
  },
  {
    name: "パスキーの確認の無い大事な操作",
    ip: "198.18.0.6",
    routes: routes.filter((r) => r.stepUp && !STEP_UP_NOT_BUILT.has(r.key)),
    // 入力の形を探らせないよう、形の違う入力でも確認を先に求める
    allowed: (answer) => answer.status === 401 && answer.code === "step_up_required",
    send: (api, route, origin) => send(api, route, { headers: { Origin: origin }, id: "not-an-id", ...(route.body ? { data: '{"unknown":' } : {}) }),
  },
];

test.describe("弱点のチェック", () => {
  for (const attack of ATTACKS) {
    test(attack.name, async ({ playwright, baseURL }) => {
      test.setTimeout(60_000);
      expect(attack.routes.length).toBeGreaterThan(0);
      const origin = String(baseURL);
      // 送信元ごとに 1 分 300 回なので、攻撃ごとに送信元を変える
      const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { "CF-Connecting-IP": attack.ip } });
      // 攻撃はログインした人のクッキーを持たないものと、持つものがある。持つ側のためにセッションを 1 つ作る
      expect((await api.post("/api/v1/sessions", { headers: { Origin: origin, "Content-Type": "application/json" } })).status()).toBe(201);
      expect((await api.get("/api/v1/me")).status()).toBe(200);
      const bad: string[] = [];
      for (const route of attack.routes) {
        const answer = await attack.send(api, route, origin);
        if (!attack.allowed(answer)) bad.push(`${route.key}: ${String(answer.status)} ${answer.code}`);
      }
      await api.dispose();
      expect(bad).toEqual([]);
    });
  }
});
