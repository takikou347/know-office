// DO のテストの入口と、本物の wrangler.jsonc の Worker を本物の workerd で起こす。DO のテストの入口はファイルで 1 つにし、テストごとに空にする
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import { z } from "zod";
import { CSP_NONCE_PLACEHOLDER } from "../../src/gate/screen-html.ts";
import { atFileEnd } from "./file-end.ts";

/** 起こしたテストの入口 */
export type TestWorker = {
  /** 記録 DO のメソッドを呼ぶ */
  call(method: string, ...args: unknown[]): Promise<unknown>;
  /** 記録 DO に多くの記録を、入口の中で順に足す */
  appendMany(entries: unknown[]): Promise<void>;
  /** 全体のセキュリティ DO の admit を、入口の中で何度も呼んで答えを並べる */
  admitMany(times: number, ...args: [string, "api" | "auth", number]): Promise<unknown[]>;
  /** 全体のセキュリティ DO のメソッドを呼ぶ */
  guard(method: string, ...args: unknown[]): Promise<unknown>;
  /** 社員 DO のメソッドを呼ぶ */
  staff(staffId: string, method: string, ...args: unknown[]): Promise<unknown>;
  /** D1 に SQL を流して行を返す */
  query(binding: string, sql: string): Promise<unknown[]>;
  /** R2 の FILES に置いた物を、頭の道で選んで中身ごと返す */
  files(prefix: string): Promise<{ key: string; body: string | null }[]>;
  /** 配信 DO のメソッドを呼ぶ */
  live(method: string, ...args: unknown[]): Promise<unknown>;
  /** 配信 DO に WebSocket を開かせる道。ws: から始まる */
  liveUrl(query: { session: string; ip: string; at: number }): Promise<string>;
  /** 社員のワークスペースの代わりが受けた呼び出し */
  workspace(staffId: string): Promise<{ method: string; args: unknown[] }[]>;
  /** 社員のワークスペースの代わりの答え方を決める。busy は runs にもう走っている、down は runs に届かない、abort_down は中断に答えない、abort_hold はほかの答え方に変えるまで止め終えず、その間の runs を断る */
  workspaceMode(staffId: string, mode: "ok" | "busy" | "down" | "abort_down" | "abort_hold"): Promise<void>;
  /** DO と入口が出したエラーログの行 */
  errorLogs(): Promise<string[]>;
  /** 何もしない。workerd はファイルの終わりに止める */
  dispose(): Promise<void>;
};

/**
 * マイグレーションのフォルダの文を並べる
 * @param folder main か ledger
 * @returns SQL の文
 */
function statements(folder: "main" | "ledger"): string[] {
  const dir = join(import.meta.dirname, "../../migrations", folder);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("--> statement-breakpoint"))
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/** ファイルで 1 つの、DO のテストの入口。workerd の起動と組み立てに 1 秒ほどかかるので、テストごとには起こさない */
let shared: Promise<{ api: TestWorker; reset: () => Promise<void>; dispose: () => Promise<void> }> | null = null;
/** shared をもうテストに渡したか。渡した後は、次に渡す前に DO と D1 と R2 を空にする */
let handedOut = false;

/**
 * ファイルで 1 つの入口を止める
 */
async function stop(): Promise<void> {
  const worker = shared;
  shared = null;
  handedOut = false;
  if (worker) await (await worker).dispose();
}

/**
 * DO のテストの入口を渡す。workerd はファイルで 1 つ起こし、2 回目からは DO の記憶と alarm、D1、R2 を空にし、DO を作り直させて渡す。テストごとに呼んでよい
 * @returns DO を呼ぶ call、D1 を読む query、dispose。dispose は何もしない (workerd はファイルの終わりに止める)
 */
export async function startTestWorker(): Promise<TestWorker> {
  if (!shared) {
    shared = boot();
    atFileEnd(stop);
  }
  const worker = await shared;
  if (handedOut) await worker.reset();
  handedOut = true;
  return worker.api;
}

/**
 * DO のテストの入口を起こし、マイグレーションを流す
 * @returns テストに渡す物、空にする reset、止める dispose
 */
async function boot(): Promise<{ api: TestWorker; reset: () => Promise<void>; dispose: () => Promise<void> }> {
  const worker = await unstable_startWorker({
    config: join(import.meta.dirname, "../do/wrangler.jsonc"),
    dev: { server: { port: 0 }, inspector: false, persist: false, logLevel: "error" },
  });
  const post = async (path: string, body: unknown) => {
    const res = await worker.fetch(`http://test${path}`, { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path}: ${String(res.status)} ${await res.text()}`);
    if (res.status === 204) return null;
    const json: unknown = await res.json();
    return json;
  };
  await post("/migrate", { binding: "DB", statements: statements("main") });
  await post("/migrate", { binding: "REC_2026", statements: statements("ledger") });
  await post("/migrate", { binding: "REC_2027", statements: statements("ledger") });
  await post("/migrate", { binding: "REC_2030", statements: statements("ledger") });
  const api: TestWorker = {
    call: (method, ...args) => post("/rpc", { method, args }),
    appendMany: async (entries) => {
      await post("/append-many", { entries });
    },
    admitMany: async (times, ...args) => z.array(z.unknown()).parse(await post("/admit-many", { times, args })),
    guard: (method, ...args) => post("/guard", { method, args }),
    staff: (staffId, method, ...args) => post("/staff", { staffId, method, args }),
    query: async (binding, sql) => z.array(z.unknown()).parse(await post("/query", { binding, sql })),
    files: async (prefix) => z.array(z.object({ key: z.string(), body: z.string().nullable() })).parse(await post("/files", { prefix })),
    live: (method, ...args) => post("/live", { method, args }),
    liveUrl: async (query) => {
      const url = new URL("/live-open", await worker.url);
      url.protocol = "ws:";
      url.search = new URLSearchParams({ session: query.session, ip: query.ip, at: String(query.at) }).toString();
      return url.toString();
    },
    workspace: async (staffId) => z.array(z.object({ method: z.string(), args: z.array(z.unknown()) })).parse(await post("/workspace", { staffId })),
    workspaceMode: async (staffId, mode) => {
      await post("/workspace-mode", { staffId, mode });
    },
    errorLogs: async () => z.array(z.string()).parse(await post("/logs", {})),
    dispose: () => Promise.resolve(),
  };
  return {
    api,
    reset: async () => {
      await post("/reset", { main: statements("main"), ledger: statements("ledger") });
    },
    dispose: () => worker.dispose(),
  };
}

/** 本物の wrangler.jsonc で起こした Worker */
export type OfficeWorker = {
  /** 要求を出す。path は / から始める。init が無ければ GET */
  request(path: string, headers?: Record<string, string>, init?: { method: string; body?: string }): Promise<Response>;
  /** 止めて、画面のファイルの置き場を消す */
  dispose(): Promise<void>;
};

/**
 * apps/office/wrangler.jsonc の Worker を画面のファイルと一緒に起こし、入口と画面の分かれ方 (assets の run_worker_first) を確かめられるようにする
 * @returns 要求を出す request と dispose
 */
export async function startOfficeWorker(): Promise<OfficeWorker> {
  // 作った画面は vite build の後にしか無く、テストは build の前に走るので、元の index.html だけを画面のファイルとして置く
  const assets = mkdtempSync(join(tmpdir(), "know-office-assets-"));
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  try {
    // vite の html.cspNonce が build で入れる nonce の置き場の meta を足し、JS は 1 つだけ置く
    const html = readFileSync(join(import.meta.dirname, "../../index.html"), "utf8").replace("<head>", `<head>\n    <meta property="csp-nonce" nonce="${CSP_NONCE_PLACEHOLDER}">`);
    writeFileSync(join(assets, "index.html"), html);
    mkdirSync(join(assets, "assets"));
    writeFileSync(join(assets, "assets", "main.js"), "export {};\n");
    // 画面のファイルのヘッダーは public/_headers が決め、vite build がそのまま写す
    copyFileSync(join(import.meta.dirname, "../../public/_headers"), join(assets, "_headers"));
    worker = await unstable_startWorker({
      config: join(import.meta.dirname, "../../wrangler.jsonc"),
      assets,
      // 手元の .dev.vars (開発の入口が作る) を読まず、本番と同じ CSP を確かめる
      bindings: { ENVIRONMENT: { type: "plain_text", value: "production" } },
      // vite の ?raw の代わりに、wrangler の組み立てでも OpenAPI の文書を文字列として読む
      build: { moduleRules: [{ type: "Text", globs: ["**/*.yaml?raw"] }] },
      // コンテナは Docker で作るので、入口と画面の分かれ方を見るこのテストでは起こさない
      dev: { server: { port: 0 }, inspector: false, persist: false, logLevel: "error", enableContainers: false },
    });
  } catch (error) {
    // 起こせない時も一時の置き場を残さない
    rmSync(assets, { recursive: true, force: true });
    throw error;
  }
  return {
    request: async (path, headers = {}, init = { method: "GET" }) => {
      // miniflare の Response を、テストの型と同じ Node の Response に移す
      const res = await worker.fetch(`http://test${path}`, { headers, ...init });
      return new Response(await res.text(), { status: res.status, headers: Object.fromEntries(res.headers) });
    },
    dispose: async () => {
      await worker.dispose();
      rmSync(assets, { recursive: true, force: true });
    },
  };
}
