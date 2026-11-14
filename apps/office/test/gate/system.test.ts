// 稼働確認、API ドキュメント、全ルートに共通のヘッダーとミドルウェアを確かめる。API の決まりの 1.2、3.5、3.6
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import gate from "../../src/gate/index.ts";

const v1 = readFileSync(join(import.meta.dirname, "../../openapi/v1.yaml"), "utf8");
const init = readFileSync(join(import.meta.dirname, "../../public/swagger/swagger-init.js"), "utf8");
const getRoutes = [...new Set(gate.routes.filter((r) => r.method === "GET").map((r) => r.path))];

describe("共通のヘッダー", () => {
  it("API の返事にセキュリティヘッダーと no-store が付く", async () => {
    const res = await gate.request("/api/v1/health");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
    );
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("失敗の返事にも同じヘッダーが付く", async () => {
    const res = await gate.request("/api/v1/nothing");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("共通のミドルウェアは 1 回ずつだけ登録される (trace、セキュリティヘッダー、本文の形)", () => {
    const paths = gate.routes.filter((r) => r.method === "ALL").map((r) => r.path.replace(/^\*/, "/*"));
    expect(paths).toEqual(["/*", "/api/*", "/api/*"]);
  });

  it("どの GET のルートも、ほかのメソッドには 405 と Allow を返す", async () => {
    expect(getRoutes.length).toBeGreaterThan(0);
    const results = await Promise.all(
      getRoutes.map(async (path) => {
        const res = await gate.request(path, { method: "DELETE" });
        return [path, res.status, res.headers.get("Allow")];
      }),
    );
    expect(results).toEqual(getRoutes.map((path) => [path, 405, "GET"]));
  });
});

describe("API ドキュメント", () => {
  it("Swagger UI は外のファイルを読まず、style だけ unsafe-inline を許す", async () => {
    const res = await gate.request("/api/v1/docs");
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
    const res = await gate.request("/api/v1/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/yaml; charset=utf-8");
    expect(await res.text()).toBe(v1);
  });
});
