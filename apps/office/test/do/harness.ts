// DO を本物の workerd で試すための入口。テストだけが使う
import { z } from "zod";
import { GuardDO } from "../../src/gate/do/guard.ts";
import { RecorderDO } from "../../src/gate/do/recorder.ts";
import type { Bindings } from "../../src/gate/env.ts";

export { GuardDO, RecorderDO };

const Binding = z.enum(["DB", "REC_2026", "REC_2027"]);
const Migrate = z.object({ binding: Binding, statements: z.array(z.string()) });
const Query = z.object({ binding: Binding, sql: z.string() });
const Call = z.object({ method: z.enum(["append", "verify"]), args: z.array(z.unknown()) });
const GuardCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("admit"), args: z.tuple([z.string(), z.enum(["api", "auth"]), z.number()]) }),
  z.object({ method: z.literal("fail"), args: z.tuple([z.string(), z.number()]) }),
  z.object({ method: z.literal("putChallenge"), args: z.tuple([z.string(), z.object({ challenge: z.string(), purpose: z.enum(["register", "step_up"]) }), z.number()]) }),
  z.object({ method: z.literal("takeChallenge"), args: z.tuple([z.string(), z.number()]) }),
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
    if (path === "/guard") {
      const call = GuardCall.parse(body);
      const guard = env.GUARD.get(env.GUARD.idFromName("guard"));
      if (call.method === "admit") return Response.json(await guard.admit(...call.args));
      if (call.method === "fail") return Response.json(await guard.fail(...call.args));
      if (call.method === "putChallenge") return Response.json(await guard.putChallenge(...call.args));
      return Response.json(await guard.takeChallenge(...call.args));
    }
    const { method, args } = Call.parse(body);
    const stub = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
    if (method === "append") return Response.json(await stub.append(args[0]));
    return Response.json(await stub.verify(z.number().parse(args[0])));
  },
};
