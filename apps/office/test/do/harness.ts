// DO を本物の workerd で試すための入口。テストだけが使う
import { z } from "zod";
import { RecorderDO } from "../../src/gate/do/recorder.ts";
import type { Bindings } from "../../src/gate/env.ts";

export { RecorderDO };

const Binding = z.enum(["DB", "REC_2026", "REC_2027"]);
const Migrate = z.object({ binding: Binding, statements: z.array(z.string()) });
const Query = z.object({ binding: Binding, sql: z.string() });
const Call = z.object({ method: z.enum(["append", "verify"]), args: z.array(z.unknown()) });

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
    const { method, args } = Call.parse(body);
    const stub = env.RECORDER.get(env.RECORDER.idFromName("recorder"));
    if (method === "append") return Response.json(await stub.append(args[0]));
    return Response.json(await stub.verify(z.number().parse(args[0])));
  },
};
