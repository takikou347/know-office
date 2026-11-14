// ゲートウェイをテストで起こす。D1 は手元の本物、Access は代わりの物、DO はゲートウェイから見た境目の代わりを渡す
import type { AuditInput, Clock, Fetcher } from "@know-office/core";
import { createFakeAccess, type FakeAccess } from "../../dev/access.ts";
import { GuardBook, type GuardStorage } from "../../src/gate/auth/guard-book.ts";
import type { Bindings } from "../../src/gate/env.ts";
import { createGate } from "../../src/gate/index.ts";
import type { TestD1 } from "./d1.ts";

const FAKES = "http://localhost:5199";
/** テストのゲートウェイの origin。app.request は http://localhost に要求を出す */
export const ORIGIN = "http://localhost";
/** テストのオーナー */
export const OWNER = "owner@example.com";

/** 起こしたテストのゲートウェイ */
export type TestGate = {
  /** ゲートウェイ。ルートを足すテストは signIn の前に足す */
  app: ReturnType<typeof createGate>;
  /** バインディングと変数 */
  env: Bindings;
  /** 代わりの Access。証明を出し、鍵を取り替える */
  access: FakeAccess;
  /** Access の公開鍵を取りに来た回数と、返し方。down は 503、malformed は形の違う JSON を返す */
  certs: { calls: number; answer: "ok" | "down" | "malformed" };
  /** 記録 DO に頼んだ監査ログ */
  audits: AuditInput[];
  /** ロックアウトと challenge の数え方。GuardDO と同じ物 */
  guard: GuardBook;
  /** 要求を出す */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** ログインセッションを作り、以降の要求に付けるヘッダーを返す */
  signIn(): Promise<Record<string, string>>;
};

/**
 * DO の ctx.storage と同じ形の、手元の入れ物を作る
 * @returns Map で持つ入れ物
 */
function memoryStorage(): GuardStorage {
  const map = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve(map.get(key)),
    put: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
  };
}

/**
 * 1 つの物を返す DO の名前空間の代わりを作る
 * @param stub 呼ばれる物
 * @returns idFromName と get だけを持つ名前空間
 */
function namespace<T>(stub: T) {
  return { idFromName: () => "id", get: () => stub };
}

/**
 * テストのゲートウェイを起こす
 * @param options 時刻と D1
 * @param options.clock 時刻
 * @param options.d1 手元の D1
 * @returns ゲートウェイと、ログインの手伝い
 */
export async function createTestGate(options: { clock: Clock; d1: TestD1 }): Promise<TestGate> {
  const access = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock: options.clock });
  const certs: TestGate["certs"] = { calls: 0, answer: "ok" };
  const fetcher: Fetcher = (url) => {
    if (!url.startsWith(`${FAKES}/access/`)) return Promise.reject(new Error(`テストで外へ出た: ${url}`));
    certs.calls += 1;
    if (certs.answer === "down") return Promise.resolve(new Response("", { status: 503 }));
    if (certs.answer === "malformed") return Promise.resolve(Response.json({ keys: "none" }));
    return Promise.resolve(access.app.request(url.slice(`${FAKES}/access`.length)));
  };
  const audits: AuditInput[] = [];
  const guard = new GuardBook(memoryStorage(), () => Promise.resolve());
  const recorder = {
    append: (input: AuditInput) => {
      audits.push(input);
      return Promise.resolve({ id: String(audits.length), hash: "0".repeat(64) });
    },
  };
  // DO はゲートウェイの外の境目なので、同じ数え方を手元で持つ代わりを渡す。DO そのものは test/do/ で本物の workerd で確かめる
  // 代わりの DO は名前空間の一部 (idFromName と get) だけを持つので、Bindings として渡す
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const env = {
    DB: options.d1.DB,
    REC_2026: options.d1.REC_2026,
    REC_2027: options.d1.REC_2027,
    GUARD: namespace(guard),
    RECORDER: namespace(recorder),
    ENVIRONMENT: "development",
    DEV_FAKES_URL: FAKES,
    ACCESS_TEAM: "test",
    ACCESS_AUD: "test-aud",
    OWNER_EMAIL: OWNER,
    MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  } as unknown as Bindings;
  const app = createGate({ clock: options.clock, fetch: fetcher });
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, init, env));
  return {
    app,
    env,
    access,
    certs,
    audits,
    guard,
    request,
    signIn: async () => {
      const proof = await access.sign();
      const res = await request("/api/v1/sessions", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": proof, Origin: ORIGIN } });
      if (res.status !== 201) throw new Error(`ログインできない: ${String(res.status)} ${await res.text()}`);
      const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      return { "Cf-Access-Jwt-Assertion": proof, Cookie: cookie, Origin: ORIGIN };
    },
  };
}
