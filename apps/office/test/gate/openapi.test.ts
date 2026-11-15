// コードのルートが v1.yaml と合う事、v1.yaml が OpenAPI 3.1 として正しい事を確かめる。API の決まりの 3.5
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import gate from "../../src/gate/index.ts";

const Operation = z.object({
  operationId: z.string(),
  tags: z.array(z.string()),
  parameters: z
    .array(z.object({ name: z.string().optional(), in: z.string().optional(), required: z.boolean().optional(), $ref: z.string().optional() }))
    .optional(),
  requestBody: z.object({ content: z.record(z.string(), z.unknown()) }).optional(),
  responses: z.record(z.string(), z.object({ $ref: z.string().optional(), content: z.record(z.string(), z.unknown()).optional() })),
  "x-step-up": z.union([z.boolean(), z.string()]).optional(),
});
type Operation = z.infer<typeof Operation>;
const Doc = z.object({
  openapi: z.string(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.record(z.string(), z.record(z.string(), z.unknown())),
});
type Doc = z.infer<typeof Doc>;

const METHODS = ["get", "post", "put", "patch", "delete"];
const text = readFileSync(join(import.meta.dirname, "../../openapi/v1.yaml"), "utf8");
const v1 = Doc.parse(parse(text));
const code = Doc.parse(gate.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "know-office", version: "0" } }));

/**
 * 操作を、比べる所だけの形に直す
 * @param op OpenAPI の操作
 * @returns operationId、tags、パラメーター、本文、応答のステータスと形
 */
function shape(op: Operation) {
  return {
    operationId: op.operationId,
    tags: op.tags,
    parameters: (op.parameters ?? []).map((p) => p.$ref ?? `${p.in}:${p.name}:${String(p.required ?? false)}`).toSorted((a, b) => a.localeCompare(b)),
    requestBody: Object.keys(op.requestBody?.content ?? {}),
    responses: Object.fromEntries(Object.entries(op.responses).map(([status, r]) => [status, r.$ref ?? Object.keys(r.content ?? {})])),
    stepUp: op["x-step-up"] ?? false,
  };
}

/**
 * 文書の操作を「メソッド パス」ごとに並べる
 * @param doc OpenAPI の文書
 * @returns 「メソッド パス」から操作への対応
 */
function operations(doc: Doc): Map<string, Operation> {
  const out = new Map<string, Operation>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (METHODS.includes(method)) out.set(`${method.toUpperCase()} ${path}`, Operation.parse(op));
    }
  }
  return out;
}

/**
 * スキーマから説明の文を外す。説明は v1.yaml だけに書く
 * @param value スキーマ
 * @returns description を除いたスキーマ
 */
function withoutDescription(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescription);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "description").map(([k, v]) => [k, withoutDescription(v)]));
  }
  return value;
}

/**
 * v1.yaml にあってコードにまだ無いルートと、受け持つ Issue。作ったら消す。デプロイの前に空にする
 */
const UNBUILT: Record<string, string> = {
  "DELETE /api/v1/staff/{staffId}/orders/{orderId}": "#107",
  "GET /api/v1/dashboard": "#76",
  "GET /api/v1/errors": "#111",
  "GET /api/v1/live": "#76",
  "GET /api/v1/records/attendance": "#107",
  "GET /api/v1/records/uptime": "#107",
  "GET /api/v1/reviews/{nodeId}/lsp": "#110",
  "GET /api/v1/staff": "#107",
  "GET /api/v1/staff/{staffId}/messages": "#107",
  "GET /api/v1/traces/{traceId}": "#111",
  "POST /api/v1/live/tickets": "#76",
  "POST /api/v1/services/{serviceId}/rollback": "#109",
  "POST /api/v1/staff/{staffId}/messages": "#107",
  "POST /api/v1/staff/{staffId}/orders": "#107",
  "POST /v1/abort": "#105",
  "POST /v1/messages": "#105",
  "POST /ws/v1/events": "#105",
  "POST /ws/v1/tools/{toolName}": "#103",
};

/**
 * ディレクトリの下の .ts の中身をすべて読む
 * @param dir 読むディレクトリ
 * @returns 中身をつないだ文
 */
function sources(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}
const gateSource = sources(join(import.meta.dirname, "../../src/gate"));
const workspaceSource = sources(join(import.meta.dirname, "../../../workspace/src"));

/**
 * ゲートウェイの OpenAPI の文書に入らないルート (ワークスペースからの /ws/v1/ と、ワークスペースの /v1/) が作られているか
 * @param key 「メソッド パス」
 * @returns /ws/v1/ は同じメソッドとパスの createRoute、/v1/ はワークスペースのサーバーの振り分けがあれば true
 */
function builtElsewhere(key: string): boolean {
  const [method = "", path = ""] = key.split(" ");
  // createRoute の method と path は続く 2 行に書く。コメントや別のメソッドの同じパスでは作った事にしない
  if (path.startsWith("/ws/v1/")) return gateSource.includes(`createRoute({\n  method: "${method.toLowerCase()}",\n  path: "${path}",`);
  // ワークスペースのサーバーは「メソッド パス」を route と比べて振り分ける
  if (path.startsWith("/v1/")) return workspaceSource.includes(`route === "${key}"`);
  return false;
}

describe("OpenAPI の文書", () => {
  const ours = operations(code);
  const spec = operations(v1);

  it("コードのルートはどれも v1.yaml にあり、同じ形をしている", () => {
    expect(ours.size).toBeGreaterThan(0);
    const keys = [...ours.keys()];
    expect(keys.filter((key) => !spec.has(key))).toEqual([]);
    const shapes = (ops: Map<string, Operation>) =>
      Object.fromEntries(
        keys.flatMap((key) => {
          const op = ops.get(key);
          return op ? [[key, shape(op)]] : [];
        }),
      );
    expect(shapes(ours)).toEqual(shapes(spec));
  });

  it("v1.yaml のルートはどれもコードにあるか、まだ作っていない物として Issue と並べてある", () => {
    const missing = [...spec.keys()].filter((key) => !ours.has(key) && !builtElsewhere(key)).toSorted((a, b) => a.localeCompare(b));
    expect(missing).toEqual(Object.keys(UNBUILT).toSorted((a, b) => a.localeCompare(b)));
  });

  it("デプロイの時は、まだ作っていないルートが残っていない", () => {
    if (process.env["RELEASE"] !== "1") return;
    expect(Object.keys(UNBUILT)).toEqual([]);
  });

  it("コードが登録したスキーマは v1.yaml の同じ名前のスキーマと同じ", () => {
    const names = Object.keys(code.components["schemas"] ?? {});
    const pick = (doc: Doc) => Object.fromEntries(names.map((name) => [name, withoutDescription(doc.components["schemas"]?.[name])]));
    expect(pick(code)).toEqual(pick(v1));
  });

  it("v1.yaml が OpenAPI 3.1 として正しい", () => {
    expect(v1.openapi).toBe("3.1.0");
    const refs = [...text.matchAll(/\$ref: '?#\/components\/(\w+)\/(\w+)'?/g)].map(([, kind = "", name = ""]) => `${kind}/${name}`);
    expect(refs.filter((ref) => {
      const [kind = "", name = ""] = ref.split("/");
      return v1.components[kind]?.[name] === undefined;
    })).toEqual([]);
    const declared: Record<string, (string | undefined)[]> = {};
    const wanted: Record<string, (string | undefined)[]> = {};
    for (const [key, op] of spec) {
      const path = key.split(" ")[1] ?? "";
      declared[key] = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name).toSorted((a = "", b = "") => a.localeCompare(b));
      wanted[key] = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).toSorted((a = "", b = "") => a.localeCompare(b));
    }
    expect(declared).toEqual(wanted);
  });
});
