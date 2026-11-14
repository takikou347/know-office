// ゲートウェイをテストで起こす。D1 は手元の本物、Access は代わりの物、DO はゲートウェイから見た境目の代わりを渡す
import { AppError, type AuditInput, type Clock, type Fetcher, type StaffId } from "@know-office/core";
import { createFakeAccess, type FakeAccess } from "../../dev/access.ts";
import { GuardBook, type GuardStorage } from "../../src/gate/auth/guard-book.ts";
import type { Bindings } from "../../src/gate/env.ts";
import type { GuardDeps, ReviewAnswer } from "../../src/gate/guard/deps.ts";
import { OfficeGuard } from "../../src/gate/guard/office-guard.ts";
import { StaffGuard } from "../../src/gate/guard/staff-guard.ts";
import { createGate } from "../../src/gate/index.ts";
import { pullNext } from "../../src/gate/work/loop.ts";
import { StaffBook, type StaffStorage, type Workspace } from "../../src/gate/work/staff-book.ts";
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
  /** 記録 DO の size() が返す、置き場ごとのバイト数 */
  storage: Record<string, number>;
  /** ロックアウトと challenge の数え方。GuardDO と同じ物 */
  guard: GuardBook;
  /** 全体とサービスの数え方。GuardDO と同じ物 */
  office: OfficeGuard;
  /** 社員ごとの、勤務と数え方の代わり。StaffDO と同じ物 */
  staff: Record<StaffId, TestStaff>;
  /** 社員ごとのワークスペースの代わり。差し替えた作業トークンを並べ、down なら届かない */
  workspaces: Record<StaffId, TestWorkspace>;
  /** 自動停止が外へ頼む口の代わり。戻したサービスと、レビュー担当の答え */
  deps: GuardDeps & { rollbacks: string[]; answer: ReviewAnswer | null };
  /** 要求を出す */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** ログインセッションを作り、以降の要求に付けるヘッダーを返す */
  signIn(): Promise<Record<string, string>>;
};

/** 社員 1 人の代わり。StaffDO と同じ本を持ち、ワークスペースへの呼び出しを並べる */
export type TestStaff = {
  /** 勤務の本 */
  book: StaffBook;
  /** 数え方と作業トークンの本 */
  guard: StaffGuard;
  /** ワークスペースへの呼び出し */
  workspace: string[];
};

/** ワークスペースの DO の代わり */
export type TestWorkspace = {
  /** 受けた作業トークン */
  tickets: string[];
  /** true なら届かない */
  down: boolean;
};

/**
 * alarm も持つ、手元の入れ物を作る
 * @returns Map で持つ入れ物
 */
function staffStorage(): StaffStorage {
  const map = new Map<string, unknown>();
  return {
    get: (key) => Promise.resolve(structuredClone(map.get(key))),
    put: (key, value) => {
      map.set(key, structuredClone(value));
      return Promise.resolve();
    },
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
  };
}

/**
 * 社員 1 人の代わりを作る
 * @param staffId 社員 ID
 * @param d1 手元の D1
 * @returns 社員の代わり
 */
function testStaff(staffId: StaffId, d1: TestD1): TestStaff {
  const calls: string[] = [];
  const workspace: Workspace = {
    start: () => Promise.resolve(void calls.push("start")),
    stop: () => Promise.resolve(void calls.push("stop")),
    wrapUp: () => Promise.resolve(void calls.push("wrapUp")),
    restart: () => Promise.resolve(void calls.push("restart")),
  };
  const storage = staffStorage();
  const book = new StaffBook(staffId, storage, d1.DB, workspace);
  return { book, guard: new StaffGuard(staffId, storage, d1.DB, book), workspace: calls };
}

/**
 * workerd の RPC と同じく、DO の中で投げた AppError を、code を持った別の Error にして投げ直す。ゲートウェイは instanceof に頼れない
 * @param call DO のメソッド
 * @returns RPC を越えた形で投げるメソッド
 */
function overRpc<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw Object.assign(new Error(error.message), { name: error.name, code: error.code, remote: true });
    }
  };
}

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
  const storage: Record<string, number> = { DB: 1024, REC_2026: 2048, REC_2027: 1024 };
  const guard = new GuardBook(memoryStorage(), () => Promise.resolve());
  const office = new OfficeGuard(memoryStorage());
  const staff: Record<StaffId, TestStaff> = { president: testStaff("president", options.d1), builder: testStaff("builder", options.d1), reviewer: testStaff("reviewer", options.d1) };
  const deps: TestGate["deps"] = {
    rollbacks: [],
    answer: null,
    rollback: (serviceId) => Promise.resolve(void deps.rollbacks.push(serviceId)),
    review: () => Promise.resolve(deps.answer),
  };
  // GuardDO はロックアウトと数え方の 2 つの本を持つ
  const guardDo = {
    admit: guard.admit.bind(guard),
    fail: guard.fail.bind(guard),
    putChallenge: guard.putChallenge.bind(guard),
    takeChallenge: guard.takeChallenge.bind(guard),
    observe: office.observe.bind(office),
    holdKeys: office.holdKeys.bind(office),
    keysHeld: office.keysHeld.bind(office),
    releaseKeys: office.releaseKeys.bind(office),
    claimStop: office.claimStop.bind(office),
    releaseStop: office.releaseStop.bind(office),
    dropClaim: office.dropClaim.bind(office),
    restoreStop: office.restoreStop.bind(office),
  };
  const workspaces: Record<StaffId, TestWorkspace> = { president: { tickets: [], down: false }, builder: { tickets: [], down: false }, reviewer: { tickets: [], down: false } };
  const workspaceDo = (id: StaffId) => ({
    replaceTicket: (ticket: string) => {
      if (workspaces[id].down) return Promise.reject(new Error("ワークスペースに届かない"));
      workspaces[id].tickets.push(ticket);
      return Promise.resolve(null);
    },
  });
  // StaffDO は勤務の本と数え方の本を持つ。名前ごとに別の代わりを返す
  const staffDo = (id: StaffId) => {
    const { book, guard: g } = staff[id];
    return {
      status: book.status.bind(book),
      wake: async (now: number) => {
        await book.wake(now);
        return null;
      },
      take: overRpc(book.take.bind(book)),
      finish: overRpc(async (result: unknown, now: number) => {
        await book.finish(result, now);
        return null;
      }),
      call: overRpc(async (task: unknown, now: number) => {
        await book.call(task, now);
        return null;
      }),
      pull: (now: number) => pullNext(env, book, now),
      heartbeat: overRpc(book.heartbeat.bind(book)),
      checkpoint: overRpc(book.checkpoint.bind(book)),
      stop: book.stop.bind(book),
      resume: book.resume.bind(book),
      observe: g.observe.bind(g),
      dropTask: g.dropTask.bind(g),
      halt: g.halt.bind(g),
      resumeTask: g.resumeTask.bind(g),
      taskClock: g.taskClock.bind(g),
      issueToken: g.issueToken.bind(g),
      checkToken: g.checkToken.bind(g),
      correct: overRpc(book.correct.bind(book)),
      rebuildDay: overRpc(async (day: unknown, now: number) => {
        await book.rebuildDay(day, now);
        return null;
      }),
      renewToken: g.renewToken.bind(g),
      revokeTokens: g.revokeTokens.bind(g),
    };
  };
  const recorder = {
    append: (input: AuditInput) => {
      audits.push(input);
      return Promise.resolve({ id: String(audits.length), hash: "0".repeat(64) });
    },
    size: () => Promise.resolve(Object.entries(storage).map(([binding, bytes]) => ({ binding, bytes }))),
    find: (_at: number, action: string, target: string) => {
      const found = audits.find((a) => a.action === action && a.target === target);
      return Promise.resolve(found ? { detail: JSON.stringify(found.detail ?? null) } : null);
    },
  };
  // DO はゲートウェイの外の境目なので、同じ数え方を手元で持つ代わりを渡す。DO そのものは test/do/ で本物の workerd で確かめる
  // 代わりの DO は名前空間の一部 (idFromName と get) だけを持つので、Bindings として渡す
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const env = {
    DB: options.d1.DB,
    REC_2026: options.d1.REC_2026,
    REC_2027: options.d1.REC_2027,
    GUARD: namespace(guardDo),
    STAFF: { idFromName: (name: StaffId) => name, get: (id: StaffId) => staffDo(id) },
    RECORDER: namespace(recorder),
    WORKSPACE: { idFromName: (name: StaffId) => ({ toString: () => `ws-${name}`, name }), get: (id: { name: StaffId }) => workspaceDo(id.name) },
    ENVIRONMENT: "development",
    DEV_FAKES_URL: FAKES,
    ACCESS_TEAM: "test",
    ACCESS_AUD: "test-aud",
    OWNER_EMAIL: OWNER,
    MASTER_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  } as unknown as Bindings;
  const app = createGate({ clock: options.clock, fetch: fetcher, guard: deps });
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, init, env));
  return {
    app,
    env,
    access,
    certs,
    audits,
    storage,
    guard,
    office,
    staff,
    deps,
    workspaces,
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
