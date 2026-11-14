// 成功は { data, meta }、失敗は problem+json で返す事を確かめる。API の決まりの 2 章
import { createRoute, z } from "@hono/zod-openapi";
import { Meta, Problem } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/gate/app.ts";
import gate from "../../src/gate/index.ts";
import { ok } from "../../src/gate/respond.ts";

/**
 * 返事の本文をキーと値の組で読む
 * @param res 返事
 * @returns 本文
 */
async function read(res: Response): Promise<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(await res.json());
}

/**
 * 失敗の本文を problem+json の形で読む
 * @param res 返事
 * @returns problem+json の本文
 */
async function problem(res: Response): Promise<Problem> {
  return Problem.parse(await res.json());
}

const PROBLEM_KEYS = ["code", "detail", "instance", "status", "title", "traceId", "type"];

describe("返事の形", () => {
  it("成功は data と meta だけを持ち、meta に traceId がある", async () => {
    const res = await gate.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Object.keys(body).toSorted()).toEqual(["data", "meta"]);
    expect(body.data).toEqual({ ok: true, part: "gate" });
    expect(body.meta).toEqual({ traceId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown });
  });

  it("traceparent があれば、その trace-id を traceId に引き継ぐ", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await gate.request("/api/v1/health", { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });
    expect(Meta.parse((await read(res)).meta).traceId).toBe(traceId);
  });

  it("無いルートは 404 の problem+json を返す", async () => {
    const res = await gate.request("/api/v1/nothing");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = await read(res);
    expect(Object.keys(body).toSorted()).toEqual(PROBLEM_KEYS);
    expect(body).toMatchObject({ type: "urn:know-office:problem:not_found", status: 404, code: "not_found", instance: "/api/v1/nothing" });
  });

  it("ルートはあるがメソッドが異なれば 405 と Allow を返す", async () => {
    const res = await gate.request("/api/v1/health", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect((await problem(res)).code).toBe("method_not_allowed");
  });
});

describe("入力の失敗", () => {
  const echo = createRoute({
    method: "post",
    path: "/api/v1/echo",
    request: { body: { content: { "application/json": { schema: z.object({ title: z.string().max(5) }).strict() } } }, query: z.object({ limit: z.coerce.number().int().max(100).optional() }) },
    responses: { 200: { description: "成功", content: { "application/json": { schema: z.object({ data: z.object({ title: z.string() }), meta: z.object({ traceId: z.string() }) }) } } } },
  });
  const app = createApp().openapi(echo, (c) => ok(c, c.req.valid("json")));
  const post = (body: string, headers: Record<string, string> = { "Content-Type": "application/json" }, query = "") =>
    app.request(`/api/v1/echo${query}`, { method: "POST", body, headers });

  it("422 の errors の pointer が本文の項目を指す", async () => {
    const res = await post(JSON.stringify({ title: "長すぎるタイトル" }));
    expect(res.status).toBe(422);
    const body = await problem(res);
    expect(body.code).toBe("validation_failed");
    expect(body.errors?.map((e) => e.pointer)).toEqual(["#/title"]);
  });

  it("422 の errors の pointer はクエリを #/query/<名前> で指す", async () => {
    const res = await post(JSON.stringify({ title: "a" }), undefined, "?limit=1000");
    const body = await problem(res);
    expect(body.errors?.map((e) => e.pointer)).toEqual(["#/query/limit"]);
  });

  it("JSON として不正なら 400 malformed_request", async () => {
    const res = await post("{");
    expect(res.status).toBe(400);
    expect((await problem(res)).code).toBe("malformed_request");
  });

  it("Content-Type が application/json でなければ 415", async () => {
    const res = await post("title=a", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(res.status).toBe(415);
    expect((await problem(res)).code).toBe("unsupported_media_type");
  });

  it("本文が 1MB を超えれば 413", async () => {
    const res = await post(JSON.stringify({ title: "a".repeat(1024 * 1024) }));
    expect(res.status).toBe(413);
    expect((await problem(res)).code).toBe("payload_too_large");
  });

  it("想定外の失敗は 500 で、detail に中身を入れない", async () => {
    const boom = createApp();
    boom.get("/api/v1/boom", () => {
      throw new Error("D1 の接続文字列 secret");
    });
    const res = await boom.request("/api/v1/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret");
  });
});
