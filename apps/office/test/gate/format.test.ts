// 成功は { data, meta }、失敗は problem+json で返す事を確かめる。API の決まりの 2 章
import { createRoute, z } from "@hono/zod-openapi";
import { Meta, Problem } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../../src/gate/body.ts";
import { ok } from "../../src/gate/respond.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const echo = createRoute({
  method: "post",
  path: "/api/v1/echo",
  request: { body: { content: { "application/json": { schema: z.object({ title: z.string().max(5) }).strict() } } }, query: z.object({ limit: z.coerce.number().int().max(100).optional() }).strict() },
  responses: { 200: { description: "成功", content: { "application/json": { schema: z.object({ data: z.object({ title: z.string() }), meta: z.object({ traceId: z.string() }) }) } } } },
});

// テストごとに空の D1 とゲートウェイを作り、ログインしたヘッダーを持つ
let d1: TestD1;
let gate: TestGate;
let signedIn: Record<string, string>;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock: fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0)), d1 });
  // ルートは最初の要求の前に足す
  gate.app.openapi(echo, (c) => ok(c, c.req.valid("json")));
  gate.app.get("/api/v1/boom", () => {
    throw new Error("D1 の接続文字列 secret");
  });
  signedIn = await gate.signIn();
});
afterEach(() => d1.dispose());

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
    const res = await gate.request("/api/v1/health", { headers: signedIn });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(Object.keys(body).toSorted()).toEqual(["data", "meta"]);
    expect(body.data).toEqual({ ok: true, part: "gate" });
    expect(body.meta).toEqual({ traceId: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown });
  });

  it("traceparent があれば、その trace-id を traceId に引き継ぐ", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await gate.request("/api/v1/health", { headers: { ...signedIn, traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });
    expect(Meta.parse((await read(res)).meta).traceId).toBe(traceId);
  });

  it("無いルートは 404 の problem+json を返す", async () => {
    const res = await gate.request("/api/v1/nothing", { headers: signedIn });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = await read(res);
    expect(Object.keys(body).toSorted()).toEqual(PROBLEM_KEYS);
    expect(body).toMatchObject({ type: "urn:know-office:problem:not_found", status: 404, code: "not_found", instance: "/api/v1/nothing" });
  });

  it("ルートはあるがメソッドが異なれば 405 と Allow を返す", async () => {
    const res = await gate.request("/api/v1/health", { method: "DELETE", headers: signedIn });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect((await problem(res)).code).toBe("method_not_allowed");
  });
});

/**
 * ログインしたヘッダーで echo に本文を送る
 * @param body 本文
 * @param headers 足すヘッダー
 * @param query クエリ
 * @returns 返事
 */
function post(body: string, headers: Record<string, string> = { "Content-Type": "application/json" }, query = ""): Promise<Response> {
  return gate.request(`/api/v1/echo${query}`, { method: "POST", body, headers: { ...signedIn, ...headers } });
}

describe("入力の失敗", () => {

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

  it("知らないクエリパラメーターは 400 malformed_request", async () => {
    const res = await post(JSON.stringify({ title: "a" }), undefined, "?limit=1&unknown=1");
    expect(res.status).toBe(400);
    expect((await problem(res)).code).toBe("malformed_request");
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

  it("Content-Length が 1MB を超えれば、本文を読む前に 413", async () => {
    const untouchable = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("本文を読んだ");
      },
    });
    const res = await gate.request("/api/v1/echo", {
      method: "POST",
      body: untouchable,
      headers: { ...signedIn, "Content-Type": "application/json", "Content-Length": String(MAX_BODY_BYTES + 1) },
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("Content-Length が無ければ、1MB を超えた所で読むのを止めて 413", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const res = await gate.request("/api/v1/echo", {
      method: "POST",
      body: endless,
      headers: { ...signedIn, "Content-Type": "application/json" },
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  }, 5000);

  it("想定外の失敗は 500 で、detail に中身を入れない", async () => {
    const res = await gate.request("/api/v1/boom", { headers: signedIn });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret");
  });
});
