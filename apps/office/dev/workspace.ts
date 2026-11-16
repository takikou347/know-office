// 開発環境の代わりのワークスペースの置き場。ゲートウェイの DevContainer が起こさせ、Node のサーバーへの要求をここから回す (ログインと記録の 3.9、社員が考えるの 3.1)
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StaffId } from "@know-office/core";
import { Hono } from "hono";
import { z } from "zod";

/** 起こした代わりのワークスペース。apps/workspace/src/dev.ts の DevWorkspace と同じ形 */
export type DevWorkspace = { port: number; events: unknown[][]; close(): Promise<void> };

/** 代わりのワークスペースを起こす関数。apps/workspace/src/dev.ts の startDevWorkspace と同じ形 */
export type StartDevWorkspace = (options: { key: string; anthropicUrl: string }) => Promise<DevWorkspace>;

/** 代わりのワークスペースが受けたタスクの開始 */
export type ReceivedRun = { staffId: StaffId; nodeId: string };

/** 代わりのワークスペースの置き場 */
export type DevWorkspaces = {
  /** /:staffId/boot、/:staffId/stop、/:staffId/v1/*、/__fake/runs を持つ Hono */
  app: Hono;
  /** 受けたタスクの開始 */
  runs: ReceivedRun[];
  /** 起こした物をすべて止める */
  close(): Promise<void>;
};

const Boot = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const RunBody = z.object({ nodeId: z.uuid() }).loose();
const Methods = new Set(["GET", "POST", "PUT"]);
/** apps/workspace の startDevWorkspace が返す形 */
const Started = z.object({
  port: z.number().int().positive(),
  events: z.array(z.array(z.unknown())),
  close: z.custom<() => Promise<void>>((v) => typeof v === "function"),
});

/**
 * apps/workspace の startDevWorkspace を読み込む。vite の設定と一緒に束ねず、Node が apps/workspace の依存のまま読む
 * @returns startDevWorkspace
 * @throws Error 形が違う時
 */
async function loadWorkspace(): Promise<StartDevWorkspace> {
  const url = pathToFileURL(join(import.meta.dirname, "../../workspace/src/dev.ts")).href;
  const loaded: unknown = await import(/* @vite-ignore */ url);
  const start: unknown = typeof loaded === "object" && loaded !== null && "startDevWorkspace" in loaded ? loaded.startDevWorkspace : undefined;
  if (typeof start !== "function") throw new Error("apps/workspace/src/dev.ts に startDevWorkspace が無い");
  return async (options) => {
    const made: unknown = await Reflect.apply(start, undefined, [options]);
    return Started.parse(made);
  };
}

/**
 * 代わりのワークスペースの置き場を作る
 * @param anthropicUrl 代わりの Claude API の宛先 (DEV_FAKES_URL/anthropic)
 * @param start 代わりのワークスペースを起こす関数。省くと apps/workspace の物
 * @returns Hono、受けたタスクの開始、止める口
 */
export function createDevWorkspaces(anthropicUrl: string, start?: StartDevWorkspace): DevWorkspaces {
  const running = new Map<StaffId, DevWorkspace>();
  const runs: ReceivedRun[] = [];
  const stop = async (staffId: StaffId) => {
    const held = running.get(staffId);
    running.delete(staffId);
    await held?.close();
  };
  const app = new Hono()
    .get("/__fake/runs", (c) => c.json(runs))
    .post("/:staffId/boot", async (c) => {
      const staffId = StaffId.safeParse(c.req.param("staffId"));
      const body = Boot.safeParse(await c.req.json().catch(() => null));
      if (!staffId.success || !body.success) return c.body(null, 400);
      await stop(staffId.data);
      running.set(staffId.data, await (start ?? (await loadWorkspace()))({ key: body.data.key, anthropicUrl }));
      return c.body(null, 204);
    })
    .post("/:staffId/stop", async (c) => {
      const staffId = StaffId.safeParse(c.req.param("staffId"));
      if (!staffId.success) return c.body(null, 400);
      await stop(staffId.data);
      return c.body(null, 204);
    })
    .all("/:staffId/v1/*", async (c) => {
      const staffId = StaffId.safeParse(c.req.param("staffId"));
      const held = staffId.success ? running.get(staffId.data) : undefined;
      if (!staffId.success || !held || !Methods.has(c.req.method)) return c.body(null, 502);
      // 付けた先 (/workspace) によらず、社員 ID の後の /v1/ から先を回す
      const pathname = new URL(c.req.url).pathname;
      const path = pathname.slice(pathname.indexOf(`/${staffId.data}/v1/`) + `/${staffId.data}`.length);
      const body = c.req.method === "GET" ? undefined : await c.req.text();
      const headers: Record<string, string> = { "content-type": "application/json" };
      const auth = c.req.header("authorization");
      if (auth !== undefined) headers["authorization"] = auth;
      const res = await fetch(`http://127.0.0.1:${String(held.port)}${path}`, { method: c.req.method, headers, ...(body === undefined ? {} : { body }) });
      if (path === "/v1/runs" && res.status === 202) {
        const run = RunBody.safeParse(JSON.parse(body ?? "null"));
        if (run.success) runs.push({ staffId: staffId.data, nodeId: run.data.nodeId });
      }
      return new Response(res.body, { status: res.status, headers: res.headers });
    });
  return {
    app,
    runs,
    close: async () => {
      await Promise.all([...running.keys()].map(stop));
    },
  };
}
