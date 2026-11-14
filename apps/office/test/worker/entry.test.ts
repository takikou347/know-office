// 本物の wrangler.jsonc の Worker を本物の workerd で起こし、/api/* だけが入口に来て、ほかの道は画面を返す事を確かめる
import { Problem } from "@know-office/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OfficeWorker, startOfficeWorker } from "../helpers/worker.ts";

// 入口と画面の分かれ方は要求ごとに変わらないので、workerd は 1 度だけ起こす
let worker: OfficeWorker | undefined;
beforeAll(async () => {
  worker = await startOfficeWorker();
}, 30_000);
afterAll(() => worker?.dispose());

/**
 * 起こした Worker に要求を出す
 * @param path / から始まる道
 * @param headers 付けるヘッダー
 * @returns 返事
 */
function request(path: string, headers?: Record<string, string>): Promise<Response> {
  if (!worker) throw new Error("Worker を起こせていない");
  return worker.request(path, headers);
}

// ブラウザーでアドレスを開いた時のヘッダー。画面のファイルの SPA への戻しは、この開き方の時に効く
const NAVIGATE = { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };

describe("入口と画面の分かれ方 (wrangler.jsonc)", () => {
  it("Access を通らない要求", async () => {
    const res = await request("/api/v1/health");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(Problem.parse(await res.json()).code).toBe("unauthenticated");
  });

  it("ブラウザーで /api の下を開いても入口が受け、画面を返さない", async () => {
    const res = await request("/api/v1/health", NAVIGATE);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    expect(Problem.parse(await res.json()).code).toBe("unauthenticated");
  });

  it("/api の下の知らない道も入口が受け、画面を返さない", async () => {
    const res = await request("/api/v1/nothing", NAVIGATE);
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
  });

  it.each(["/", "/dashboard", "/settings/sessions"])("ブラウザーで %s を開くと入口を通らず画面の index.html を返す", async (path) => {
    const res = await request(path, NAVIGATE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain('<div id="root"></div>');
  });
});
