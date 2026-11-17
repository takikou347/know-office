// ゲートウェイをテストで起こす。D1 は手元の本物、Access と Claude API は代わりの物、DO はゲートウェイから見た境目の代わりを渡す
import { AppError, type AuditInput, type Clock, type Fetcher, type StaffId } from "@know-office/core";
import { createFakeAccess, type FakeAccess } from "../../dev/access.ts";
import { createFakeClaude, type FakeClaude } from "../../dev/claude.ts";
import { createFakeGitHub, type FakeGitHub } from "../../dev/github.ts";
import { endpoints } from "../../src/gate/endpoints.ts";
import { TokenCache } from "../../src/gate/github/app.ts";
import { type GitHubAccess, httpForge, type Permissions } from "../../src/gate/github/forge.ts";
import { GuardBook, type GuardStorage } from "../../src/gate/auth/guard-book.ts";
import { noticeDenied } from "../../src/gate/ledger/notices.ts";
import type { Bindings } from "../../src/gate/env.ts";
import type { ExtensionDefinition } from "../../src/gate/extensions/define.ts";
import type { GuardDeps, ReviewAnswer } from "../../src/gate/guard/deps.ts";
import { GENESIS_HASH, verifyChain } from "../../src/gate/ledger/audit.ts";
import { OfficeGuard } from "../../src/gate/guard/office-guard.ts";
import { StaffGuard } from "../../src/gate/guard/staff-guard.ts";
import { createGate } from "../../src/gate/index.ts";
import { type Forge, pullNext, UNCONNECTED_FORGE } from "../../src/gate/work/loop.ts";
import { appendTranscript, loadTranscript, type TranscriptStore } from "../../src/gate/work/transcript.ts";
import { StaffBook, type StaffStorage, type Workspace } from "../../src/gate/work/staff-book.ts";
import type { TestD1 } from "./d1.ts";
import { accessKeyPair, githubAppKey } from "./keys.ts";
import { fakeLive, type TestLive } from "./live.ts";
import { overRpc } from "./rpc.ts";
import { type RunMarks, staffRunFakes, workspaceFake, type WorkspaceSeen } from "./staff-runs.ts";

const FAKES = "http://localhost:5199";
/** テストのゲートウェイの origin。app.request は http://localhost に要求を出す */
export const ORIGIN = "http://localhost";
/** テストの Anthropic の鍵。ゲートウェイだけが持ち、代わりの Claude API に届く */
export const ANTHROPIC_KEY = "test-anthropic-key-0123456789";
/** テストの MASTER_KEY。32 バイトの 7 */
const MASTER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
/** テストのオーナー */
export const OWNER = "owner@example.com";

/** 代わりの GitHub の compare が返すファイルの上限。GitHub と同じ */
const COMPARE_LIMIT = 300;

/** 代わりの GitHub の compare が返す 1 ファイル。GitHub の形 */
export type CompareFile = { filename: string; previous_filename?: string; status?: string; patch?: string };

/** 起こしたテストのゲートウェイ */
export type TestGate = {
  /** ゲートウェイ。ルートを足すテストは signIn の前に足す */
  app: ReturnType<typeof createGate>;
  /** バインディングと変数 */
  env: Bindings;
  /** 代わりの Access。証明を出し、鍵を取り替える */
  access: FakeAccess;
  /** 代わりの Claude API。返事を積み、届いた要求と鍵を読む */
  claude: FakeClaude;
  /** ゲートウェイが外へ出す fetch。代わりの Access、Claude API、GitHub に回す */
  fetch: Fetcher;
  /** 代わりの GitHub。files は compare がどのブランチにも返す変えたファイル。compares は「元...先」ごとに返すファイルで、あればそちらを返す。contents は「sha:道」ごとのファイルの中身。pullFiles はプルリクエストの番号ごとの変えたファイルで、無ければ files を返す。branchHeads はブランチの名前ごとの先 */
  github: FakeGitHub & { files: CompareFile[]; compares: Map<string, CompareFile[]>; contents: Map<string, string>; pullFiles: Map<number, CompareFile[]>; branchHeads: Map<string, string> };
  /** vault の App の鍵から作った 1 時間の鍵をためる所。テストごとに別にする */
  githubCache: TokenCache;
  /** GitHub の鍵を出した先と権限 */
  githubTokens: { repo: string; permissions: Permissions }[];
  /** ゲートウェイと同じ、GitHub を呼ぶ口。github を付けて起こした時だけ代わりの GitHub につなぐ */
  forge: Forge;
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
  /** 配信 DO の代わり。配った出来事と、出した作業トークン */
  live: TestLive;
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
export type TestWorkspace = WorkspaceSeen;

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
    abort: () => Promise.resolve(void calls.push("abort")),
    restart: () => Promise.resolve(void calls.push("restart")),
  };
  const storage = staffStorage();
  const book = new StaffBook(staffId, storage, d1.DB, workspace);
  return { book, guard: new StaffGuard(staffId, storage, d1.DB, book), workspace: calls };
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
 * 代わりの GitHub への道を返す。ブランチの名前はタスク ID から決まるので、compare とブランチの先は置いた返事をどのブランチにも返す
 * @param github 代わりの GitHub
 * @param path 道とクエリ
 * @returns そのまま送る道
 */
function githubPath(github: TestGate["github"], path: string): string {
  const compare = /^\/repos\/[^/]+\/[^/]+\/compare\/([^?]+)/.exec(path);
  // GitHub と同じく、compare は比べる全体で 300 ファイルまでを返し、page を付けても続きを返さない
  if (compare) github.set(`GET ${path.split("?")[0] ?? path}`, { files: (github.compares.get(decodeURIComponent(compare[1] ?? "")) ?? github.files).slice(0, COMPARE_LIMIT) });
  // プルリクエストのファイルの一覧は、per_page ごとのページで返す
  const pull = /^(\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files)\?(.*)$/.exec(path);
  if (pull) {
    const q = new URLSearchParams(pull[3]);
    const [perPage, page] = [Number(q.get("per_page") ?? "30"), Number(q.get("page") ?? "1")];
    github.set(`GET ${pull[1] ?? ""}`, (github.pullFiles.get(Number(pull[2])) ?? github.files).slice((page - 1) * perPage, page * perPage));
  }
  // contents は道が同じで ref だけが違うので、問いの ref ごとに置いた中身を返す
  const file = /^(\/repos\/[^/]+\/[^/]+\/contents\/([^?]+))\?ref=([0-9a-f]{40})$/.exec(path);
  if (file) {
    const [, route = "", name = "", ref = ""] = file;
    const content = github.contents.get(`${ref}:${decodeURIComponent(name)}`);
    github.set(`GET ${route}`, content === undefined ? undefined : { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") });
  }
  // ブランチの先は、置いた物があればそれを、無ければ b だけの sha を返す
  const head = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(path);
  if (head) github.set(`GET ${path}`, { ref: "refs/heads/x", object: { sha: github.branchHeads.get(decodeURIComponent(head[1] ?? "")) ?? "b".repeat(40) } });
  return path;
}

/**
 * テストのゲートウェイを起こす
 * @param options 時刻と D1
 * @param options.clock 時刻
 * @param options.d1 手元の D1
 * @param options.extensions 差し込む拡張。無ければ extensions/ から読み込んだ物
 * @param options.github true なら代わりの GitHub につなぐ
 * @returns ゲートウェイと、ログインの手伝い
 */
export async function createTestGate(options: { clock: Clock; d1: TestD1; extensions?: readonly ExtensionDefinition[]; github?: boolean }): Promise<TestGate> {
  const access = await createFakeAccess({ team: "test", aud: "test-aud", email: OWNER, clock: options.clock, keyPair: accessKeyPair });
  const certs: TestGate["certs"] = { calls: 0, answer: "ok" };
  const claude = createFakeClaude();
  const github: TestGate["github"] = Object.assign(createFakeGitHub({ now: () => options.clock.now(), appKey: githubAppKey, codeloadBase: `${FAKES}/codeload` }), { files: [], compares: new Map(), contents: new Map(), pullFiles: new Map(), branchHeads: new Map() });
  const githubCache = new TokenCache();
  const githubTokens: TestGate["githubTokens"] = [];
  const githubAccess: GitHubAccess = {
    appId: 1234,
    token: (repo, permissions) => {
      githubTokens.push({ repo, permissions });
      return Promise.resolve("ghs_test");
    },
  };
  const fetcher: Fetcher = (url, init) => {
    if (url.startsWith(`${FAKES}/anthropic/`)) return Promise.resolve(claude.app.request(url.slice(`${FAKES}/anthropic`.length), init));
    if (url.startsWith(`${FAKES}/github/`)) return Promise.resolve(github.app.request(githubPath(github, url.slice(`${FAKES}/github`.length)), init));
    if (url.startsWith(`${FAKES}/codeload/`)) return Promise.resolve(github.codeload.request(url.slice(`${FAKES}/codeload`.length), init));
    if (!url.startsWith(`${FAKES}/access/`)) return Promise.reject(new Error(`テストで外へ出た: ${url}`));
    certs.calls += 1;
    if (certs.answer !== "ok") return Promise.resolve(certs.answer === "down" ? new Response("", { status: 503 }) : Response.json({ keys: "none" }));
    return Promise.resolve(access.app.request(url.slice(`${FAKES}/access`.length)));
  };
  const audits: AuditInput[] = [];
  const storage: Record<string, number> = { DB: 1024, REC_2026: 2048, REC_2027: 1024 };
  const guard = new GuardBook(memoryStorage(), () => Promise.resolve(), (at, count) => noticeDenied(env, at, count, options.clock));
  const office = new OfficeGuard(memoryStorage());
  const staff: Record<StaffId, TestStaff> = { president: testStaff("president", options.d1), builder: testStaff("builder", options.d1), reviewer: testStaff("reviewer", options.d1) };
  const deps: TestGate["deps"] = {
    rollbacks: [],
    answer: null,
    rollback: (serviceId) => Promise.resolve(void deps.rollbacks.push(serviceId)),
    review: () => Promise.resolve(deps.answer),
    // 入口の分は createApp が入口のためる所で取り消す。DO から止めた時に使う
    revokeGitHubTokens: () => Promise.resolve(),
  };
  // GuardDO はロックアウトと数え方の 2 つの本を持つ
  const guardDo = {
    admit: guard.admit.bind(guard), countDenied: guard.countDenied.bind(guard),
    fail: guard.fail.bind(guard),
    putChallenge: guard.putChallenge.bind(guard),
    takeChallenge: guard.takeChallenge.bind(guard),
    observe: office.observe.bind(office),
    holdKeys: office.holdKeys.bind(office), keysHeld: office.keysHeld.bind(office),
    keyState: office.keyState.bind(office),
    releaseKeys: office.releaseKeys.bind(office),
    setThresholdHash: office.setThresholdHash.bind(office), thresholdHash: office.thresholdHash.bind(office),
    claimStop: office.claimStop.bind(office),
    releaseStop: office.releaseStop.bind(office), dropClaim: office.dropClaim.bind(office),
    restoreStop: office.restoreStop.bind(office),
  };
  const workspaces: Record<StaffId, TestWorkspace> = { president: { tickets: [], runs: [], down: false }, builder: { tickets: [], runs: [], down: false }, reviewer: { tickets: [], runs: [], down: false } };
  const workspaceDo = (id: StaffId) => workspaceFake(workspaces[id]);
  const runMarks: RunMarks = new Map();
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
      order: overRpc(async (order: unknown, now: number) => {
        await book.order(order, now);
        return null;
      }),
      call: overRpc((task: unknown, now: number, _traceId?: string, limit?: { perDay: number }) => book.call(task, now, limit)),
      // 社員 DO と同じく、続きにしたタスクかは呼び出しの始め方に使うだけで返さない
      pull: async (now: number) => {
        const { carried: _carried, ...pulled } = await pullNext(env, book, now);
        return pulled;
      },
      ...staffRunFakes(env, id, book, runMarks),
      heartbeat: overRpc(book.heartbeat.bind(book)),
      checkpoint: overRpc(book.checkpoint.bind(book)),
      stop: book.stop.bind(book),
      waitStart: overRpc(book.waitStart.bind(book)),
      waitEnd: async (now: number) => ({ waitedMs: await book.waitEnd(now) }),
      resume: book.resume.bind(book),
      observe: g.observe.bind(g),
      dropTask: g.dropTask.bind(g),
      halt: g.halt.bind(g),
      resumeTask: g.resumeTask.bind(g),
      taskClock: g.taskClock.bind(g),
      externalSources: g.externalSources.bind(g),
      issueToken: g.issueToken.bind(g),
      checkToken: g.checkToken.bind(g),
      correct: overRpc(book.correct.bind(book)),
      rebuildDay: overRpc(async (day: unknown, now: number) => {
        await book.rebuildDay(day, now);
        return null;
      }),
      renewToken: g.renewToken.bind(g),
      revokeTokens: g.revokeTokens.bind(g),
      revokeOthers: g.revokeOthers.bind(g),
      // 社員 DO は会話の記録を鎖の中で 1 つずつ足す。テストは呼び出しを重ねないので鎖を省く
      appendTranscript: overRpc(async (nodeId: string, input: unknown, now: number) => {
        await appendTranscript(transcripts, id, nodeId, input, now);
        return null;
      }),
      loadTranscript: overRpc((nodeId: string) => loadTranscript(transcripts, id, nodeId)),
    };
  };
  const { live, liveDo } = fakeLive();
  const transcripts: TranscriptStore = { db: options.d1.DB, files: options.d1.FILES, master: MASTER_KEY };
  const recorder = {
    append: (input: AuditInput) => {
      audits.push(input);
      return Promise.resolve({ id: String(audits.length), hash: "0".repeat(64) });
    },
    // 記録 DO と同じく record_years の年の置き場を頭から確かめる。DO そのものは test/do/recorder.test.ts で確かめる
    verify: overRpc(async (year: number) => {
      const row = await options.d1.DB.prepare("SELECT first_hash FROM record_years WHERE year = ?").bind(year).first<{ first_hash: string | null }>();
      const db = new Map([[2026, options.d1.REC_2026], [2027, options.d1.REC_2027]]).get(year);
      if (!row || !db) throw new AppError("not_found", `${String(year)} 年の記録が無い`);
      return verifyChain(db, row.first_hash ?? GENESIS_HASH);
    }),
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
    FILES: options.d1.FILES,
    GUARD: namespace(guardDo),
    STAFF: { idFromName: (name: StaffId) => name, get: (id: StaffId) => staffDo(id) },
    RECORDER: namespace(recorder),
    LIVE: namespace(liveDo),
    WORKSPACE: { idFromName: (name: StaffId) => ({ toString: () => `ws-${name}`, name }), get: (id: { name: StaffId }) => workspaceDo(id.name) },
    ENVIRONMENT: "development",
    DEV_FAKES_URL: FAKES,
    ACCESS_TEAM: "test",
    ACCESS_AUD: "test-aud",
    OWNER_EMAIL: OWNER,
    MASTER_KEY,
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  } as unknown as Bindings;
  const app = createGate({
    clock: options.clock,
    fetch: fetcher,
    guard: deps,
    githubTokens: githubCache,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.github === true ? { github: githubAccess } : {}),
  });
  const forge = options.github === true ? httpForge(endpoints(env).github, fetcher, githubAccess) : UNCONNECTED_FORGE;
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, init, env));
  return {
    app,
    env,
    access,
    claude,
    fetch: fetcher,
    github,
    githubTokens,
    githubCache,
    forge,
    certs,
    audits,
    storage,
    guard,
    office,
    staff,
    deps,
    live,
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
