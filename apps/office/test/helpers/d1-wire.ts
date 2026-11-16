// テストの D1 と R2 を本物の workerd (miniflare) に起こし、D1 の 1 つの文を 1 回の要求で流す口を渡す
import { createRequire } from "node:module";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

/** テストの D1 の名前と、workerd の中の D1 の ID */
const DATABASES = { DB: "local-db", REC_2026: "local-rec-2026", REC_2027: "local-rec-2027" } as const;

/** D1 の名前 */
export type D1Name = keyof typeof DATABASES;

/** 起こした workerd */
export type Wire = {
  /** 1 つの文を 1 回の要求で流す D1 */
  d1: Record<D1Name, D1Database>;
  /** 会話の記録を置く R2 */
  FILES: R2Bucket;
  /** 止める */
  dispose(): Promise<void>;
};

/** 要求に載せる 1 つの文 */
type WireStatement = { sql: string; params: unknown[] };

/** workerd に頼む 1 回の仕事 */
type Job =
  | { op: "all" | "run"; statement: WireStatement }
  | { op: "first"; statement: WireStatement; column?: string }
  | { op: "raw"; statement: WireStatement; columnNames?: boolean }
  | { op: "batch"; statements: WireStatement[] }
  | { op: "exec"; sql: string };

// workerd の中で本物の D1 の prepare、bind と、頼まれたメソッドを呼ぶ。undefined と バイト列は JSON に載らないので印を付けて送る
const SCRIPT = `
const decode = (v) => v && typeof v === "object" && "$undefined" in v ? undefined : v && typeof v === "object" && "$bytes" in v ? Uint8Array.from(atob(v.$bytes), (c) => c.charCodeAt(0)) : v;
const prepare = (db, s) => db.prepare(s.sql).bind(...s.params.map(decode));
export default {
  async fetch(request, env) {
    const { binding, job } = await request.json();
    const db = env[binding];
    try {
      let out;
      if (job.op === "all") out = await prepare(db, job.statement).all();
      else if (job.op === "run") out = await prepare(db, job.statement).run();
      else if (job.op === "first") out = job.column === undefined ? await prepare(db, job.statement).first() : await prepare(db, job.statement).first(job.column);
      else if (job.op === "raw") out = job.columnNames === undefined ? await prepare(db, job.statement).raw() : await prepare(db, job.statement).raw({ columnNames: job.columnNames });
      else if (job.op === "batch") out = await db.batch(job.statements.map((s) => prepare(db, s)));
      else if (job.op === "exec") out = await db.exec(job.sql);
      else throw new Error("知らない仕事: " + job.op);
      return Response.json({ out: out ?? null });
    } catch (error) {
      return Response.json({ error: { message: String(error?.message ?? error), cause: error?.cause ? String(error.cause.message ?? error.cause) : null } });
    }
  },
};
`;

/**
 * bind の値を JSON に載る形にする
 * @param value bind の値
 * @returns JSON に載る値
 */
function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value instanceof ArrayBuffer) return { $bytes: Buffer.from(value).toString("base64") };
  if (ArrayBuffer.isView(value)) return { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  return value;
}

/** 1 つの文。D1 と同じく bind は新しい文を返し、流すまで workerd に行かない */
class Statement {
  /**
   * 文を作る
   * @param send workerd に頼む口
   * @param statement SQL。D1 の文と同じ名前で持つ
   * @param params bind した値
   */
  constructor(
    private readonly send: (job: Job) => Promise<unknown>,
    readonly statement: string,
    readonly params: unknown[] = [],
  ) {}

  /**
   * 値を付けた新しい文を返す
   * @param values 値
   * @returns 新しい文
   */
  bind(...values: unknown[]): Statement {
    return new Statement(this.send, this.statement, values);
  }

  /**
   * 要求に載せる形
   * @returns SQL と値
   */
  wire(): WireStatement {
    return { sql: this.statement, params: this.params.map(encode) };
  }

  /**
   * 最初の行か、その列を返す
   * @param column 列
   * @returns 行か値か null
   */
  first(column?: string): Promise<unknown> {
    return this.send(column === undefined ? { op: "first", statement: this.wire() } : { op: "first", statement: this.wire(), column });
  }

  /**
   * 行を全部返す
   * @returns D1 の結果
   */
  all(): Promise<unknown> {
    return this.send({ op: "all", statement: this.wire() });
  }

  /**
   * 流す
   * @returns D1 の結果
   */
  run(): Promise<unknown> {
    return this.send({ op: "run", statement: this.wire() });
  }

  /**
   * 行を値の並びで返す
   * @param options columnNames が true なら頭に列の名前を付ける
   * @param options.columnNames 列の名前を付けるか
   * @returns 値の並び
   */
  raw(options?: { columnNames?: boolean }): Promise<unknown> {
    return this.send(options?.columnNames === undefined ? { op: "raw", statement: this.wire() } : { op: "raw", statement: this.wire(), columnNames: options.columnNames });
  }
}

/**
 * batch に渡された文を、要求に載せる形にする
 * @param list wireD1 の prepare で作った文
 * @returns SQL と値の並び
 */
function statements(list: unknown[]): WireStatement[] {
  return list.map((s) => {
    if (!(s instanceof Statement)) throw new TypeError("batch には同じ D1 の prepare で作った文を渡す");
    return s.wire();
  });
}

/**
 * 1 つの D1 を、1 つの文を 1 回の要求で流す形で作る。getPlatformProxy の D1 は prepare と bind も workerd への往復になり、文ごとに 3 往復かかる
 * @param send workerd に頼む口
 * @returns D1 と同じ形の物
 */
function wireD1(send: (job: Job) => Promise<unknown>): D1Database {
  const db = {
    prepare: (sql: string) => new Statement(send, sql),
    batch: (list: unknown[]) => send({ op: "batch", statements: statements(list) }),
    exec: (sql: string) => send({ op: "exec", sql }),
    dump: () => Promise.reject(new Error("dump は使わない")),
    withSession: () => ({ prepare: db.prepare, batch: db.batch, getBookmark: () => null }),
  };
  // 使うメソッドだけを持つ、D1 と同じ形の物
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return db as unknown as D1Database;
}

/**
 * workerd を起こし、D1 と R2 を渡す。miniflare は wrangler が使う物を読む
 * @returns D1、R2、dispose
 */
export async function startWire(): Promise<Wire> {
  const fromWrangler = createRequire(createRequire(import.meta.url).resolve("wrangler"));
  // wrangler と同じ版の miniflare を、型を持たずに読む
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { Miniflare, convertV4MiniflareOptions } = (await import(fromWrangler.resolve("miniflare"))) as {
    Miniflare: new (options: unknown) => {
      ready: Promise<URL>;
      dispatchFetch(url: string, init: { method: string; body: string }): Promise<{ json(): Promise<unknown> }>;
      getR2Bucket(name: string): Promise<R2Bucket>;
      dispose(): Promise<void>;
    };
    convertV4MiniflareOptions: (options: unknown) => unknown;
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: SCRIPT, compatibilityDate: "2026-11-01", d1Databases: DATABASES, r2Buckets: ["FILES"] }));
  await mf.ready;
  const sender = (binding: D1Name) => async (job: Job) => {
    // テストが fetch を差し替えても届くよう、miniflare の dispatchFetch で送る
    const res = await mf.dispatchFetch("http://d1/", { method: "POST", body: JSON.stringify({ binding, job }) });
    // 上の SCRIPT が返す形
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const body = (await res.json()) as { out?: unknown; error?: { message: string; cause: string | null } };
    if (body.error) throw new Error(body.error.message, body.error.cause === null ? undefined : { cause: new Error(body.error.cause) });
    return body.out;
  };
  return {
    d1: { DB: wireD1(sender("DB")), REC_2026: wireD1(sender("REC_2026")), REC_2027: wireD1(sender("REC_2027")) },
    FILES: await mf.getR2Bucket("FILES"),
    dispose: () => mf.dispose(),
  };
}
