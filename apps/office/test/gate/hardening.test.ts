// WAF が無い時の守りを、v1.yaml とコードのルートの一覧から全ルートに当てて確かめる。API の決まりの 3.6
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { Problem } from "@know-office/core";
import { stepUpGate } from "../../src/gate/auth/passkey.ts";
import { MAX_BODY_BYTES } from "../../src/gate/body.ts";
import gate from "../../src/gate/index.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, ORIGIN, type TestGate } from "../helpers/gate.ts";
import { STEP_UP_NOT_BUILT } from "../helpers/step-up.ts";

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

/**
 * 認証を外してよい操作と、その代わりの守り。ここに足す時は API の決まりの 3.6 の 1 を直してから
 */
const WITHOUT_LOGIN = new Map([
  ["POST /hooks/v1/github", "Access を外す唯一のパス。X-Hub-Signature-256 で確かめる"],
  ["POST /ws/v1/heartbeat", "ワークスペースの出口のプロキシだけが届け、送信元の社員をプロキシが決める"],
  ["POST /ws/v1/checkpoints", "ワークスペースの出口のプロキシだけが届け、送信元の社員をプロキシが決める"],
  ["GET /v1/health", "ワークスペースの中のサーバー。社員 DO からしか届かない"],
]);

/** 入口のミドルウェアが掛かる /api/ のルート。認証を外したルートは、それぞれの代わりの守りをそのテストで確かめる (GitHub の通知は test/github/hooks.test.ts) */
const apiRoutes = codeRoutes.filter((r) => !WITHOUT_LOGIN.has(r.key));
const writeRoutes = apiRoutes.filter((r) => !SAFE.has(r.method));
/** 本文を受けるメソッドのルート。DELETE は本文を読まない */
const bodyRoutes = apiRoutes.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method));

/** ログインセッションを確かめないルート。middleware.ts の WITHOUT_SESSION と同じ。GitHub から戻る 2 つは SameSite=Strict のクッキーが付かないので、Access の証明と state か installation_id で確かめる */
const WITHOUT_SESSION = new Set(["POST /api/v1/sessions", "GET /api/v1/health", "GET /api/v1/github/callback", "GET /api/v1/github/installed"]);

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

type Init = (route: (typeof codeRoutes)[number]) => { url?: string; headers: Record<string, string>; body?: string };

/**
 * 全ルートに同じ悪い要求を出し、ルートごとの返事を返す
 * @param routes 要求を出すルート
 * @param init ルートごとの要求の設定
 * @param net 送信元の頭の 3 つ。同じテストで 2 度回す時は変え、1 分の数を分ける
 * @returns 「メソッド パス」から返事への対応
 */
async function responses(routes: typeof codeRoutes, init: Init, net = "198.51.100"): Promise<Map<string, Response>> {
  const out = new Map<string, Response>();
  for (const [i, route] of routes.entries()) {
    const { url, headers, ...rest } = init(route);
    // ログインの失敗は送信元ごとに 5 回でロックアウトになるので、決めた送信元の無い要求はルートごとに送信元を変える
    const from = { "CF-Connecting-IP": `${net}.${String(i + 1)}`, ...headers };
    out.set(route.key, await test.request(url ?? fill(route.path), { method: route.method, headers: from, ...rest }));
  }
  return out;
}

/**
 * 全ルートに同じ悪い要求を出し、ルートごとの状態コードを返す
 * @param routes 要求を出すルート
 * @param init ルートごとの要求の設定
 * @param net 送信元の頭の 3 つ
 * @returns 「メソッド パス」から状態コードへの対応
 */
async function statuses(routes: typeof codeRoutes, init: Init, net?: string): Promise<Record<string, number>> {
  return Object.fromEntries([...(await responses(routes, init, net))].map(([key, res]) => [key, res.status]));
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

  it("コードのルートはどれも、認証を外す決めた物のほかは v1.yaml でログインを求め、入口のミドルウェアが掛かる /api/ の下にある", () => {
    expect(apiRoutes.length).toBeGreaterThan(0);
    expect(apiRoutes.filter((r) => !r.path.startsWith("/api/")).map((r) => r.key)).toEqual([]);
    // 認証を外したコードのルートは /api/ の外に置き、入口のミドルウェアを掛けない
    expect(codeRoutes.filter((r) => WITHOUT_LOGIN.has(r.key)).map((r) => r.key)).toEqual(["POST /hooks/v1/github"]);
    const withoutLogin = apiRoutes.filter((r) => {
      const security = specOps.get(r.key)?.security;
      return !Array.isArray(security) || !JSON.stringify(security).includes("accessJwt");
    });
    expect(withoutLogin.map((r) => r.key)).toEqual([]);
  });

  it("どのルートも、ログインの証明の無い要求を 401 で断る", async () => {
    expect(await statuses(codeRoutes, () => ({ headers: { Origin: ORIGIN } }))).toEqual(every(codeRoutes, 401));
  });

  it("どのルートも、壊れたクッキーを 401 で断る", async () => {
    const routes = apiRoutes.filter((r) => !WITHOUT_SESSION.has(r.key));
    const proof = signedIn["Cf-Access-Jwt-Assertion"] ?? "";
    const result = await statuses(routes, () => ({
      headers: { "Cf-Access-Jwt-Assertion": proof, Cookie: "__Host-ko_session=broken.%00.cookie", Origin: ORIGIN },
    }));
    expect(result).toEqual(every(routes, 401));
  });

  it("書き込みのルートはどれも、Origin が違うか無ければ 403 で断る", async () => {
    const other = await statuses(writeRoutes, () => ({ headers: { ...signedIn, Origin: "https://evil.example" } }));
    expect(other).toEqual(every(writeRoutes, 403));
    // 1 度目と同じ送信元だと、1 分 1 回のルートが Origin を見る前に 429 になるので、送信元を変える
    const none = await statuses(writeRoutes, () => {
      const { Origin: _, ...headers } = signedIn;
      return { headers };
    }, "203.0.113");
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
    const result = await responses(routes, (r) => ({
      url: `${fill(r.path, "not-an-id")}?unknown=1`,
      headers: { ...signedIn, "Content-Type": "application/json" },
      ...(SAFE.has(r.method) ? {} : { body: "{\"unknown\":" }),
    }));
    const answers: Record<string, string> = {};
    for (const [key, res] of result) answers[key] = `${String(res.status)} ${Problem.parse(await res.json()).code}`;
    expect(answers).toEqual(Object.fromEntries(routes.map((r) => [r.key, "401 step_up_required"])));
  });

  it("x-step-up が true の操作は、コードにあれば stepUpGate を通り、まだ無い物は作る時まで許可リストに挙げる", () => {
    const required = [...specOps].filter(([key, op]) => key.includes(" /api/") && op["x-step-up"] === true).map(([key]) => key);
    const built = new Set(codeRoutes.map((r) => r.key));
    // 許可リストのルートを作ったら、ここで落ちる。許可リストから外し、createRoute の middleware に stepUpGate を置く
    expect(required.filter((key) => !built.has(key)).toSorted()).toEqual([...STEP_UP_NOT_BUILT].toSorted());
    const gated = required.filter((key) => built.has(key));
    expect(gated.length).toBeGreaterThan(0);
    // ハンドラーの中の requireStepUp では入力の検証の後になるので、ルートのミドルウェアとして登録されている事を求める
    const withGate = gated.filter((key) => gate.routes.some((r) => `${r.method} ${r.path.replaceAll(/:(\w+)/g, "{$1}")}` === key && r.handler === stepUpGate));
    expect(withGate).toEqual(gated);
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

/**
 * 断られた続きの通知を数える
 * @returns denied_burst の通知の数
 */
async function bursts(): Promise<number> {
  const row = await d1.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE kind = 'denied_burst'").first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 断った数を GuardDO の数え方に直に足す。1 回ずつ要求を出すと 5 秒を超えるので、超える手前までをここで数える
 * @param n 回数
 */
async function prefill(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await test.guard.countDenied(clock.now());
}

/**
 * Access の証明を付けずに呼び、401 を返させる
 * @param ip 送信元
 * @param path 呼ぶ道
 */
async function unauthenticated(ip = "192.0.2.1", path = "/api/v1/notices"): Promise<void> {
  expect((await test.request(path, { headers: { "CF-Connecting-IP": ip } })).status).toBe(401);
}

describe("401、403、429 が 5 分に 50 回を超えたら知らせる", () => {
  it("5 分に 50 回では出さず、51 回目で通知を 1 件出す", async () => {
    await prefill(49);
    await unauthenticated();
    expect(await bursts()).toBe(0);
    await unauthenticated("192.0.2.2");
    expect(await bursts()).toBe(1);
    const row = await d1.DB.prepare("SELECT level, scope, read_at FROM notices WHERE kind = 'denied_burst'").first();
    expect(row).toEqual({ level: "warn", scope: "office", read_at: null });
    // 開いている画面には配信の印で届ける
    const id = await d1.DB.prepare("SELECT id FROM notices WHERE kind = 'denied_burst'").first<string>("id");
    expect(test.live.published).toContainEqual({ type: "notice", notice: { id } });
  });

  it("401、403、429 を合わせて数える", async () => {
    await prefill(48);
    await unauthenticated();
    const forbidden = await test.request("/api/v1/notices/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/read", { method: "POST", headers: { ...signedIn, Origin: "https://evil.example" } });
    expect(forbidden.status).toBe(403);
    // ハッシュチェーンの確かめは 1 分に 1 回まで。2 回目は 429
    const verify = { method: "POST", headers: { ...signedIn, Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.9" } };
    expect((await test.request("/api/v1/audit-logs/verify", verify)).status).not.toBe(429);
    expect(await bursts()).toBe(0);
    expect((await test.request("/api/v1/audit-logs/verify", verify)).status).toBe(429);
    expect(await bursts()).toBe(1);
  });

  it("5 分より前の数は入れない", async () => {
    await prefill(50);
    clock.advance(5 * MINUTE);
    await unauthenticated();
    expect(await bursts()).toBe(0);
  });

  it("続く間は、読むまで同じ通知を重ねない", async () => {
    await prefill(60);
    clock.advance(6 * MINUTE);
    await prefill(50);
    await unauthenticated();
    expect(await bursts()).toBe(1);
    await d1.DB.prepare("UPDATE notices SET read_at = ? WHERE kind = 'denied_burst'").bind(clock.now()).run();
    clock.advance(6 * MINUTE);
    await prefill(50);
    await unauthenticated("192.0.2.2");
    expect(await bursts()).toBe(2);
  });

  it("同時に 51 回目と 52 回目が来ても、通知は 1 件", async () => {
    await prefill(50);
    await Promise.all([unauthenticated("192.0.2.3"), unauthenticated("192.0.2.4")]);
    expect(await bursts()).toBe(1);
  });

  it("/api/v1/ と /ws/v1/ のほかの道は数えない", async () => {
    await prefill(50);
    const res = await test.request("/hooks/v1/github", { method: "POST", headers: { "CF-Connecting-IP": "192.0.2.5", "X-GitHub-Event": "ping", "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(await bursts()).toBe(0);
  });

  it("ロックアウトの 403 は 1 回ずつ数え、2 度数えない", async () => {
    await prefill(40);
    // 同じ送信元で 5 回失敗するとロックアウトになり、その後は 403
    const from = { "CF-Connecting-IP": "198.51.100.77" };
    const seen: number[] = [];
    for (let i = 0; i < 10; i += 1) seen.push((await test.request("/api/v1/notices", { headers: from })).status);
    expect(seen).toEqual([401, 401, 401, 401, 401, 403, 403, 403, 403, 403]);
    expect(await bursts()).toBe(0);
    expect((await test.request("/api/v1/notices", { headers: from })).status).toBe(403);
    expect(await bursts()).toBe(1);
  });

  it("通知を書けなくても返事は変わらない", async () => {
    await prefill(50);
    const real = test.env.DB;
    // 通知の文だけを落とす。D1 のうち、ゲートウェイの使うメソッドだけを持つ包み
    const wrapped = {
      prepare: (sql: string) => {
        if (sql.includes("denied_burst")) throw new Error("書けない");
        return real.prepare(sql);
      },
      batch: (statements: Parameters<typeof real.batch>[0]) => real.batch(statements),
      exec: (query: string) => real.exec(query),
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    test.env.DB = wrapped as unknown as typeof real;
    await unauthenticated();
    test.env.DB = real;
    expect(await bursts()).toBe(0);
  });
});
