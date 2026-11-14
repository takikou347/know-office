// 稼働確認、API ドキュメント、全ルートに共通のヘッダーとミドルウェアを確かめる。API の決まりの 1.2、3.5、3.6
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import gate from "../../src/gate/index.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const v1 = readFileSync(join(import.meta.dirname, "../../openapi/v1.yaml"), "utf8");
const init = readFileSync(join(import.meta.dirname, "../../public/swagger/swagger-init.js"), "utf8");
const getRoutes = [...new Set(gate.routes.filter((r) => r.method === "GET").map((r) => r.path))];

// テストごとに空の D1 とゲートウェイを作り、ログインしたヘッダーで呼ぶ
let d1: TestD1;
let test: TestGate;
let signedIn: Record<string, string>;
beforeEach(async () => {
  d1 = await createTestD1();
  test = await createTestGate({ clock: fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0)), d1 });
  signedIn = await test.signIn();
});
afterEach(() => d1.dispose());

/**
 * ログインしたヘッダーで要求を出す
 * @param path パス
 * @param options 要求の設定
 * @returns 返事
 */
function call(path: string, options: RequestInit = {}): Promise<Response> {
  return test.request(path, { ...options, headers: signedIn });
}

/**
 * そのパスに登録したメソッドを Allow の形で並べる
 * @param path ルートのパス
 * @returns 「DELETE, GET」の形
 */
function allowOf(path: string): string {
  return [...new Set(gate.routes.filter((r) => r.path === path && r.method !== "ALL").map((r) => r.method))].toSorted().join(", ");
}

describe("共通のヘッダー", () => {
  it("API の返事にセキュリティヘッダーと no-store が付く", async () => {
    const res = await call("/api/v1/health");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
    );
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("失敗の返事にも同じヘッダーが付く", async () => {
    const res = await call("/api/v1/nothing");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("共通のミドルウェアは 1 回ずつだけ登録される (時刻、trace、セキュリティヘッダー、入口、Access、セッション、Origin、本文の形)", () => {
    const paths = gate.routes.filter((r) => r.method === "ALL").map((r) => r.path.replace(/^\*/, "/*"));
    expect(paths).toEqual(["/*", "/*", "/api/*", "/api/*", "/api/*", "/api/*", "/api/*", "/api/*"]);
  });

  it("どの GET のルートも、無いメソッドには 405 と、そのパスで使えるメソッドの Allow を返す", async () => {
    expect(getRoutes.length).toBeGreaterThan(0);
    const results = await Promise.all(
      getRoutes.map(async (path) => {
        const res = await call(path, { method: "PUT" });
        return [path, res.status, res.headers.get("Allow")];
      }),
    );
    expect(results).toEqual(getRoutes.map((path) => [path, 405, allowOf(path)]));
  });
});

describe("API ドキュメント", () => {
  it("Swagger UI は外のファイルを読まず、style だけ unsafe-inline を許す", async () => {
    const res = await call("/api/v1/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("style-src 'self' 'unsafe-inline';");
    expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src 'self' 'unsafe-inline'");
    const html = await res.text();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<script src="/swagger/swagger-init.js"></script>');
  });

  it("Swagger UI から API を呼べず、外の検証にも送らない", () => {
    expect(init).toContain("supportedSubmitMethods: []");
    expect(init).toContain("validatorUrl: null");
    expect(init).not.toMatch(/https?:\/\//);
  });

  it("文書は v1.yaml をそのまま application/yaml で返す", async () => {
    const res = await call("/api/v1/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/yaml; charset=utf-8");
    expect(await res.text()).toBe(v1);
  });
});
