// DO を本物の workerd で試すための入口。テストだけが使う
import { z } from "zod";
import { GuardDO } from "../../src/gate/do/guard.ts";
import { RecorderDO } from "../../src/gate/do/recorder.ts";
import { StaffDO } from "../../src/gate/do/staff.ts";
import type { Bindings } from "../../src/gate/env.ts";

export { GuardDO, RecorderDO, StaffDO };

const Binding = z.enum(["DB", "REC_2026", "REC_2027"]);
const Migrate = z.object({ binding: Binding, statements: z.array(z.string()) });
const Query = z.object({ binding: Binding, sql: z.string() });
const AdmitMany = z.object({ times: z.number().int().positive(), args: z.tuple([z.string(), z.enum(["api", "auth"]), z.number()]) });
const AppendMany = z.object({ entries: z.array(z.unknown()) });
const Call = z.object({ method: z.enum(["append", "verify", "size", "find"]), args: z.array(z.unknown()) });
const StaffCall = z.object({
  staffId: z.enum(["president", "builder", "reviewer"]),
  method: z.enum([
    "wake",
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
    const path = new URL(req.url).pathname;
    const body: unknown = await req.json();
    if (path === "/migrate") {
      const { binding, statements } = Migrate.parse(body);
      for (const sql of statements) await d1(env, binding).prepare(sql).run();
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
        if (method === "halt" || method === "taskClock") return Response.json(await stub[method](num(0)));
        if (method === "wake" || method === "heartbeat" || method === "waitEnd" || method === "stop" || method === "resume") return Response.json(await stub[method](num(0)));
        return Response.json(await stub[method](args[0], num(1)));
      } catch (error) {
        // RPC を越えた AppError は code を失うので、中身の文を返してテストで比べる
        return new Response(String(error), { status: 409 });
      }
    }
    if (path === "/guard") {
      const call = GuardCall.parse(body);
      const guard = env.GUARD.get(env.GUARD.idFromName("guard"));
      if (call.method === "admit") return Response.json(await guard.admit(...call.args));
      if (call.method === "fail") return Response.json(await guard.fail(...call.args));
      if (call.method === "putChallenge") return Response.json(await guard.putChallenge(...call.args));
      if (call.method === "observe") return Response.json(await guard.observe(...call.args));
      if (call.method === "keysHeld") return Response.json(await guard.keysHeld());
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
