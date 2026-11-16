// DO を本物の workerd で試すための入口。テストだけが使う
import { DurableObject } from "cloudflare:workers";
import { AppError, toBase64 } from "@know-office/core";
import { z } from "zod";
import { GuardDO as BaseGuardDO } from "../../src/gate/do/guard.ts";
import { LiveDO as BaseLiveDO } from "../../src/gate/do/live.ts";
import { RecorderDO as BaseRecorderDO } from "../../src/gate/do/recorder.ts";
import { StaffDO as BaseStaffDO } from "../../src/gate/do/staff.ts";
import { WorkspaceDO } from "../../src/gate/do/workspace.ts";
import type { Bindings, WorkspaceContainer } from "../../src/gate/env.ts";

export { WorkspaceDO };

/**
 * DO の記憶と alarm を消し、DO を作り直させる。workerd をファイルで 1 つにし、テストの間で DO を起き直した事にする
 * @param ctx DO の ctx
 * @returns 返らない。abort が投げる
 */
async function wipe(ctx: DurableObjectState): Promise<null> {
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
  // 記憶の外 (フィールド) に持つ物も捨てるため、次の呼び出しで新しく作らせる
  ctx.abort("テストの間で作り直す");
  return null;
}

/** テストの間で作り直せる全体のセキュリティ DO */
export class GuardDO extends BaseGuardDO {
  /**
   * 記憶を消して作り直させる
   * @returns 返らない
   */
  testReset(): Promise<null> {
    return wipe(this.ctx);
  }
}

/** テストの間で作り直せる配信 DO */
export class LiveDO extends BaseLiveDO {
  /**
   * 記憶を消して作り直させる
   * @returns 返らない
   */
  testReset(): Promise<null> {
    return wipe(this.ctx);
  }
}

/** テストの間で作り直せる記録 DO */
export class RecorderDO extends BaseRecorderDO {
  /**
   * 記憶を消して作り直させる
   * @returns 返らない
   */
  testReset(): Promise<null> {
    return wipe(this.ctx);
  }
}

/** テストの間で作り直せる社員 DO */
export class StaffDO extends BaseStaffDO {
  /**
   * 記憶を消して作り直させる
   * @returns 返らない
   */
  testReset(): Promise<null> {
    return wipe(this.ctx);
  }
}

/** DO と入口が console.error と console.warn に出したエラーログの行 (error と warn)。手元の workerd では DO と入口が同じ isolate で動くので、ここに並べてテストで読む */
const ERROR_LOGS: string[] = [];
// oxlint-disable-next-line eslint/no-console
const printError = console.error.bind(console);
// oxlint-disable-next-line eslint/no-console
const printWarn = console.warn.bind(console);
// oxlint-disable-next-line eslint/no-console
console.error = (...args: unknown[]) => {
  ERROR_LOGS.push(args.map(String).join(" "));
  printError(...args);
};
// oxlint-disable-next-line eslint/no-console
console.warn = (...args: unknown[]) => {
  ERROR_LOGS.push(args.map(String).join(" "));
  printWarn(...args);
};

/** 配信 DO への呼び出し */
const LiveCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("issue"), args: z.tuple([z.number()]) }),
  z.object({ method: z.literal("redeem"), args: z.tuple([z.string(), z.number()]) }),
  z.object({ method: z.literal("publish"), args: z.tuple([z.unknown()]) }),
  z.object({ method: z.literal("closeSession"), args: z.tuple([z.string()]) }),
  z.object({ method: z.literal("closeAll"), args: z.tuple([z.string().nullable()]) }),
]);

/** ワークスペースへの呼び出し 1 回 */
const WorkspaceCalls = z.array(z.object({ method: z.string(), args: z.array(z.unknown()) }));

/** ワークスペースのコンテナの DO の代わり。呼び出しを記憶に並べる */
export class RecordingWorkspace extends DurableObject<Bindings> implements WorkspaceContainer {
  /**
   * 呼び出しを並べる
   * @param method メソッド
   * @param args 引数
   * @returns 無し
   */
  async #push(method: string, ...args: unknown[]): Promise<null> {
    await this.ctx.storage.put("calls", [...(await this.calls()), { method, args }]);
    return null;
  }

  /**
   * 並べた呼び出しを返す
   * @returns 呼び出しの並び
   */
  async calls(): Promise<z.infer<typeof WorkspaceCalls>> {
    return WorkspaceCalls.parse((await this.ctx.storage.get("calls")) ?? []);
  }

  /**
   * 起こす
   * @param staffId 社員 ID
   * @returns 無し
   */
  start(staffId: string): Promise<null> {
    return this.#push("start", staffId);
  }

  /**
   * 止める
   * @returns 無し
   */
  stop(): Promise<null> {
    return this.#push("stop");
  }

  /**
   * 作り直す
   * @param staffId 社員 ID
   * @returns 無し
   */
  restart(staffId: string): Promise<null> {
    return this.#push("restart", staffId);
  }

  /**
   * 鍵を確かめる。コンテナを起こさないので、どの鍵も認めない
   * @returns false
   */
  holdsKey(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * 経過を書き残させる
   * @returns 無し
   */
  wrapUp(): Promise<null> {
    return this.#push("wrapUp");
  }

  /**
   * 呼び出しを始めさせる
   * @param input RunInput
   * @returns 無し
   */
  async run(input: unknown): Promise<null> {
    await this.#push("run", input);
    // テストが決めた答え方。busy はもう走っている、down は届かない
    const mode = await this.ctx.storage.get("mode");
    if (mode === "busy") throw new AppError("conflict", "ワークスペースがもう走っている");
    if (mode === "down") throw new AppError("unavailable", "ワークスペースに届かない");
    return null;
  }

  /**
   * runs の答え方を決める
   * @param mode ok、busy、down
   * @returns 無し
   */
  async setMode(mode: string): Promise<null> {
    await this.ctx.storage.put("mode", mode);
    return null;
  }

  /**
   * 中断させる
   * @param reason 理由
   * @returns 無し
   */
  async abort(reason: string): Promise<null> {
    await this.#push("abort", reason);
    // テストが決めた答え方。abort_down は中断に答えない
    if ((await this.ctx.storage.get("mode")) === "abort_down") throw new AppError("unavailable", "ワークスペースが中断に答えない");
    return null;
  }

  /**
   * 作業トークンを差し替えさせる
   * @param ticket 作業トークン
   * @returns 無し
   */
  replaceTicket(ticket: string): Promise<null> {
    return this.#push("replaceTicket", ticket);
  }

  /**
   * 会話の記録を戻させる
   * @param input RestoreInput
   * @returns 無し
   */
  restore(input: unknown): Promise<null> {
    return this.#push("restore", input);
  }

  /**
   * 記憶を消して作り直させる
   * @returns 返らない
   */
  testReset(): Promise<null> {
    return wipe(this.ctx);
  }
}

const Binding = z.enum(["DB", "REC_2026", "REC_2027", "REC_2030"]);
const Migrate = z.object({ binding: Binding, statements: z.array(z.string()) });
const Query = z.object({ binding: Binding, sql: z.string() });
const Reset = z.object({ main: z.array(z.string()), ledger: z.array(z.string()) });
/** 社員 ID。入口が受ける物と同じ */
const STAFF_IDS = ["president", "builder", "reviewer"] as const;
const AdmitMany = z.object({ times: z.number().int().positive(), args: z.tuple([z.string(), z.enum(["api", "auth"]), z.number()]) });
const AppendMany = z.object({ entries: z.array(z.unknown()) });
const Call = z.object({ method: z.enum(["append", "verify", "size", "find"]), args: z.array(z.unknown()) });
const StaffCall = z.object({
  staffId: z.enum(STAFF_IDS),
  method: z.enum([
    "wake",
    "pull",
    "arm",
    "status",
    "heartbeat",
    "checkpoint",
    "take",
    "finish",
    "order",
    "call",
    "waitStart",
    "waitEnd",
    "stop",
    "resume",
    "correct",
    "observe",
    "dropTask",
    "halt",
    "resumeTask",
    "taskClock",
    "issueToken",
    "checkToken",
    "rebuildDay",
    "appendTranscript",
    "loadTranscript",
  ]),
  args: z.array(z.unknown()),
});
const GuardCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("admit"), args: z.tuple([z.string(), z.enum(["api", "auth"]), z.number()]) }),
  z.object({ method: z.literal("fail"), args: z.tuple([z.string(), z.number()]) }),
  z.object({ method: z.literal("putChallenge"), args: z.tuple([z.string(), z.object({ challenge: z.string(), purpose: z.enum(["register", "step_up"]) }), z.number()]) }),
  z.object({ method: z.literal("takeChallenge"), args: z.tuple([z.string(), z.number()]) }),
  z.object({ method: z.literal("observe"), args: z.tuple([z.unknown(), z.number(), z.unknown()]) }),
  z.object({ method: z.literal("keysHeld"), args: z.tuple([]) }),
  z.object({ method: z.literal("setThresholdHash"), args: z.tuple([z.string()]) }),
  z.object({ method: z.literal("thresholdHash"), args: z.tuple([]) }),
  z.object({ method: z.literal("claimStop"), args: z.tuple([z.string(), z.string(), z.string()]) }),
  z.object({ method: z.literal("releaseStop"), args: z.tuple([z.string()]) }),
  z.object({ method: z.literal("restoreStop"), args: z.tuple([z.string(), z.string(), z.string()]) }),
]);

/**
 * 名前の D1 を返す
 * @param env バインディング
 * @param name 名前
 * @returns D1
 */
function d1(env: Bindings, name: z.infer<typeof Binding>) {
  const db = env[name];
  if (!db) throw new Error(`${name} が無い`);
  return db;
}

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const live = env.LIVE.get(env.LIVE.idFromName("live"));
    if (path === "/live-open") {
      // ゲートウェイが確かめた後と同じ見出しで、配信 DO に WebSocket を開かせる
      const headers = { Upgrade: "websocket", "x-live-session": url.searchParams.get("session") ?? "", "x-live-ip": url.searchParams.get("ip") ?? "", "x-live-at": url.searchParams.get("at") ?? "" };
      const res = await live.fetch("https://live.internal/", { headers });
      return new Response(null, { status: res.status, webSocket: res.webSocket });
    }
    const body: unknown = await req.json();
    if (path === "/live") {
      const call = LiveCall.parse(body);
      if (call.method === "issue") return Response.json(await live.issue(call.args[0]));
      if (call.method === "redeem") return Response.json(await live.redeem(call.args[0], call.args[1]));
      if (call.method === "publish") return Response.json(await live.publish(call.args[0]));
      if (call.method === "closeSession") return Response.json(await live.closeSession(call.args[0]));
      return Response.json(await live.closeAll(call.args[0]));
    }
    if (path === "/migrate") {
      const { binding, statements } = Migrate.parse(body);
      for (const sql of statements) await d1(env, binding).prepare(sql).run();
      return new Response(null, { status: 204 });
    }
    if (path === "/reset") {
      // 入口が名前を付けて起こす DO は、全体の 1 つずつと社員ごとの物だけ。DO の中から呼ぶ先も同じ名前に限られる
      const { main, ledger } = Reset.parse(body);
      const named = [
        env.GUARD.get(env.GUARD.idFromName("guard")),
        env.RECORDER.get(env.RECORDER.idFromName("recorder")),
        live,
        ...STAFF_IDS.flatMap((id) => [env.STAFF.get(env.STAFF.idFromName(id)), env.WORKSPACE.get(env.WORKSPACE.idFromName(id))]),
      ];
      // どの DO にもこの入口が testReset を足している
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const stubs = named as unknown as { testReset(): Promise<null> }[];
      // abort で必ず投げるので、投げた事は気にしない
      await Promise.all(stubs.map((stub) => stub.testReset().catch(() => null)));
      // エラーログの行は isolate に並べているので、前のテストの物を捨てる
      ERROR_LOGS.length = 0;
      for (const binding of Binding.options) {
        const db = d1(env, binding);
        const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
        const drops = tables.results.map((t) => db.prepare(`DROP TABLE IF EXISTS "${t.name}"`));
        if (drops.length > 0) await db.batch(drops);
        await db.batch((binding === "DB" ? main : ledger).map((sql) => db.prepare(sql)));
      }
      for (;;) {
        const listed = await env.FILES.list({ limit: 1000 });
        if (listed.objects.length === 0) break;
        await env.FILES.delete(listed.objects.map((o) => o.key));
      }
      return new Response(null, { status: 204 });
    }
    if (path === "/query") {
      const { binding, sql } = Query.parse(body);
      return Response.json((await d1(env, binding).prepare(sql).all()).results);
    }
    if (path === "/append-many") {
      // 多くの記録を流し込むテストのために、往復を 1 回にして入口の中で順に足す
      const stub = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
      for (const entry of AppendMany.parse(body).entries) await stub.append(entry);
      return new Response(null, { status: 204 });
    }
    if (path === "/admit-many") {
      // レート制限の上限まで呼ぶテストのために、往復を 1 回にして入口の中で順に呼び、答えを並べて返す
      const { times, args } = AdmitMany.parse(body);
      const guard = env.GUARD.get(env.GUARD.idFromName("guard"));
      const answers = [];
      for (let n = 0; n < times; n += 1) answers.push(await guard.admit(...args));
      return Response.json(answers);
    }
    if (path === "/staff") {
      const { staffId, method, args } = StaffCall.parse(body);
      const stub = env.STAFF.get(env.STAFF.idFromName(staffId));
      const num = (i: number) => z.number().parse(args[i]);
      try {
        if (method === "status") return Response.json(await stub.status(num(0)));
        if (method === "correct") return Response.json(await stub.correct(z.string().parse(args[0]), args[1], num(2)));
        if (method === "take") return Response.json(await stub.take(args[0], z.number().nullable().parse(args[1]), num(2)));
        if (method === "observe") return Response.json(await stub.observe(args[0], num(1), args[2]));
        if (method === "dropTask") return Response.json(await stub.dropTask(z.string().parse(args[0]), num(1)));
        if (method === "resumeTask") return Response.json(await stub.resumeTask(z.string().parse(args[0])));
        if (method === "issueToken") return Response.json(await stub.issueToken(z.string().parse(args[0]), z.string().parse(args[1]), num(2)));
        if (method === "checkToken") return Response.json(await stub.checkToken(z.string().parse(args[0]), z.string().parse(args[1]), num(2)));
        if (method === "appendTranscript") return Response.json(await stub.appendTranscript(z.string().parse(args[0]), args[1], num(2)));
        if (method === "loadTranscript") return Response.json(await stub.loadTranscript(z.string().parse(args[0])));
        if (method === "halt" || method === "taskClock") return Response.json(await stub[method](num(0)));
        if (method === "pull" || method === "arm") return Response.json(await stub[method](num(0)));
        if (method === "wake" || method === "heartbeat" || method === "waitEnd" || method === "stop" || method === "resume") return Response.json(await stub[method](num(0)));
        return Response.json(await stub[method](args[0], num(1)));
      } catch (error) {
        // RPC を越えた AppError はクラスを失い、code だけが残る。ゲートウェイが頼る code を、中身の文と一緒に返してテストで比べる
        const code = error instanceof Error && "code" in error ? String(error.code) : "none";
        return new Response(`${String(error)} code=${code}`, { status: 409 });
      }
    }
    if (path === "/files") {
      // R2 に置いた物を、中身ごと base64 で返す。暗号になっているかをテストで見る
      const listed = await env.FILES.list({ prefix: z.object({ prefix: z.string() }).parse(body).prefix });
      const files = [];
      for (const object of listed.objects) {
        const got = await env.FILES.get(object.key);
        files.push({ key: object.key, body: got ? toBase64(await got.arrayBuffer()) : null });
      }
      return Response.json(files);
    }
    if (path === "/workspace-mode") {
      const { staffId, mode } = z.object({ staffId: z.string(), mode: z.enum(["ok", "busy", "down", "abort_down"]) }).parse(body);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return Response.json(await (env.WORKSPACE.get(env.WORKSPACE.idFromName(staffId)) as unknown as RecordingWorkspace).setMode(mode));
    }
    if (path === "/logs") return Response.json(ERROR_LOGS);
    if (path === "/workspace") {
      const { staffId } = z.object({ staffId: z.string() }).parse(body);
      const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(staffId));
      // WORKSPACE には呼び出しを並べる代わりを結んでいる
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return Response.json(await (stub as unknown as RecordingWorkspace).calls());
    }
    if (path === "/guard") {
      const call = GuardCall.parse(body);
      const guard = env.GUARD.get(env.GUARD.idFromName("guard"));
      if (call.method === "admit") return Response.json(await guard.admit(...call.args));
      if (call.method === "fail") return Response.json(await guard.fail(...call.args));
      if (call.method === "putChallenge") return Response.json(await guard.putChallenge(...call.args));
      if (call.method === "observe") return Response.json(await guard.observe(...call.args));
      if (call.method === "keysHeld") return Response.json(await guard.keysHeld());
      if (call.method === "setThresholdHash") return Response.json(await guard.setThresholdHash(...call.args));
      if (call.method === "thresholdHash") return Response.json(await guard.thresholdHash());
      if (call.method === "claimStop") return Response.json(await guard.claimStop(...call.args));
      if (call.method === "releaseStop") return Response.json(await guard.releaseStop(...call.args));
      if (call.method === "restoreStop") return Response.json(await guard.restoreStop(...call.args));
      return Response.json(await guard.takeChallenge(...call.args));
    }
    const { method, args } = Call.parse(body);
    const stub = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
    if (method === "append") return Response.json(await stub.append(args[0]));
    if (method === "size") return Response.json(await stub.size());
    if (method === "find") return Response.json(await stub.find(z.number().parse(args[0]), z.string().parse(args[1]), z.string().parse(args[2])));
    return Response.json(await stub.verify(z.number().parse(args[0])));
  },
};
