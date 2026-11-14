// DO のテストの入口を本物の workerd で起こし、マイグレーションを流す
import { readdirSync, readFileSync } from "node:fs";
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
