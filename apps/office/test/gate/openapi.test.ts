// v1.yaml がコードのルートとスキーマから作った物そのままで、OpenAPI 3.1 として正しい事を確かめる。API の決まりの 4.1
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { openApiDocument, openApiYaml } from "../../src/gate/api-doc.ts";
import gate from "../../src/gate/index.ts";
import { PLANNED_ROUTES } from "../../src/gate/routes/planned.ts";
import { WORKSPACE_ROUTES } from "../../src/gate/work/workspace-api.ts";

const V1 = join(import.meta.dirname, "../../openapi/v1.yaml");
const METHODS = ["get", "post", "put", "patch", "delete"];

const Doc = z.object({
  openapi: z.string(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const Operation = z.object({ parameters: z.array(z.object({ name: z.string().optional(), in: z.string().optional() })).optional(), "x-errors": z.array(z.string()).optional() });

const text = readFileSync(V1, "utf8");
const v1 = Doc.parse(parse(text));

/** v1.yaml の操作を「メソッド パス」ごとに並べる */
const specOps = new Map(
  Object.entries(v1.paths).flatMap(([path, item]) =>
    Object.entries(item).flatMap(([method, op]) => (METHODS.includes(method) ? [[`${method.toUpperCase()} ${path}`, Operation.parse(op)] as const] : [])),
  ),
);

/**
 * createRoute の「メソッド パス」を返す
 * @param route createRoute の定義
 * @param route.method メソッド
 * @param route.path パス
 * @returns 「メソッド パス」
 */
const keyOf = (route: { method: string; path: string }) => `${route.method.toUpperCase()} ${route.path}`;

describe("OpenAPI の文書", () => {
  it("v1.yaml はコードのルートとスキーマから作った物そのまま", async () => {
    // 違えば pnpm --filter @know-office/office openapi で作り直す
    await expect(openApiYaml()).toMatchFileSnapshot(V1);
  });

  it("v1.yaml は YAML 1.1 と 1.2 のどちらで読んでも、コードから作った文書と同じ物になる", () => {
    // PyYAML のような YAML 1.1 の読み手は、off や yes を真偽に変える
    const generated: unknown = JSON.parse(JSON.stringify(openApiDocument()));
    expect(parse(text, { version: "1.2" })).toEqual(generated);
    expect(parse(text, { version: "1.1" })).toEqual(generated);
  });

  it("ワークスペースのサーバーのルートは、どれもサーバーが振り分け、振り分ける道はどれも文書にある", () => {
    const server = readFileSync(join(import.meta.dirname, "../../../workspace/src/server.ts"), "utf8");
    const routed = [...server.matchAll(/route === "([A-Z]+ \/v1\/[^"]+)"/g)].map((m) => m[1] ?? "").toSorted((a, b) => a.localeCompare(b));
    expect(WORKSPACE_ROUTES.map(keyOf).toSorted((a, b) => a.localeCompare(b))).toEqual(routed);
  });

  it("まだ作っていないルートは、ゲートウェイがまだ受けていない", () => {
    const served = new Set(gate.routes.map((r) => `${r.method} ${r.path.replaceAll(/:(\w+)/g, "{$1}")}`));
    expect(PLANNED_ROUTES.map(({ route }) => keyOf(route)).filter((key) => served.has(key))).toEqual([]);
  });

  it("デプロイの時は、まだ作っていないルートが残っていない", () => {
    if (process.env["RELEASE"] !== "1") return;
    expect(PLANNED_ROUTES.map(({ route, issue }) => `${keyOf(route)} ${issue}`)).toEqual([]);
  });

  it("v1.yaml が OpenAPI 3.1 として正しい", () => {
    expect(v1.openapi).toBe("3.1.0");
    const refs = [...text.matchAll(/\$ref: ["']?#\/components\/(\w+)\/(\w+)["']?/g)].map(([, kind = "", name = ""]) => [kind, name] as const);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter(([kind, name]) => v1.components[kind]?.[name] === undefined)).toEqual([]);
    const declared: Record<string, (string | undefined)[]> = {};
    const wanted: Record<string, (string | undefined)[]> = {};
    for (const [key, op] of specOps) {
      const path = key.split(" ")[1] ?? "";
      declared[key] = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name).toSorted((a = "", b = "") => a.localeCompare(b));
      wanted[key] = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).toSorted((a = "", b = "") => a.localeCompare(b));
    }
    expect(declared).toEqual(wanted);
  });

  it("GitHub を呼んで 502 を返しうるルートは、GitHub の上限の 429 も書く", () => {
    const calls = [...specOps].filter(([, op]) => (op["x-errors"] ?? []).some((e) => e.startsWith("502 `upstream_failed`")) && (op["x-errors"] ?? []).join(" ").includes("GitHub"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(([, op]) => !(op["x-errors"] ?? []).some((e) => e.startsWith("429 `rate_limited`: GitHub"))).map(([key]) => key)).toEqual([]);
  });
});
