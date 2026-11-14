// DO のテストの入口と、本物の wrangler.jsonc の Worker を本物の workerd で起こす
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import { z } from "zod";

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
  /** 止める */
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

/**
 * DO のテストの入口を起こす
 * @returns DO を呼ぶ call、D1 を読む query、dispose
 */
export async function startTestWorker(): Promise<TestWorker> {
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
  return {
    call: (method, ...args) => post("/rpc", { method, args }),
    appendMany: async (entries) => {
      await post("/append-many", { entries });
    },
    admitMany: async (times, ...args) => z.array(z.unknown()).parse(await post("/admit-many", { times, args })),
    guard: (method, ...args) => post("/guard", { method, args }),
    staff: (staffId, method, ...args) => post("/staff", { staffId, method, args }),
    query: async (binding, sql) => z.array(z.unknown()).parse(await post("/query", { binding, sql })),
    dispose: () => worker.dispose(),
  };
}

/** 本物の wrangler.jsonc で起こした Worker */
export type OfficeWorker = {
  /** GET の要求を出す。path は / から始める */
  request(path: string, headers?: Record<string, string>): Promise<Response>;
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
    copyFileSync(join(import.meta.dirname, "../../index.html"), join(assets, "index.html"));
    worker = await unstable_startWorker({
      config: join(import.meta.dirname, "../../wrangler.jsonc"),
      assets,
      // vite の ?raw の代わりに、wrangler の組み立てでも OpenAPI の文書を文字列として読む
      build: { moduleRules: [{ type: "Text", globs: ["**/*.yaml?raw"] }] },
      dev: { server: { port: 0 }, inspector: false, persist: false, logLevel: "error" },
    });
  } catch (error) {
    // 起こせない時も一時の置き場を残さない
    rmSync(assets, { recursive: true, force: true });
    throw error;
  }
  return {
    request: async (path, headers = {}) => {
      // miniflare の Response を、テストの型と同じ Node の Response に移す
      const res = await worker.fetch(`http://test${path}`, { headers });
      return new Response(await res.text(), { status: res.status, headers: Object.fromEntries(res.headers) });
    },
    dispose: async () => {
      await worker.dispose();
      rmSync(assets, { recursive: true, force: true });
    },
  };
}
