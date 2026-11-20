// Web アプリのサービスが訪問とアプリの 5xx を共通のデータセットに書く共有の型を確かめる。サービスと拡張の 3.2
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countRequests, isServerError, isVisitNavigation, REQUESTS_DATASET, type RequestPoint, type RequestsDataset } from "../src/index.ts";

/** 書いた点を控える、Analytics Engine のデータセットの代わり */
type FakeDataset = RequestsDataset & { points: RequestPoint[] };

/**
 * 書いた点を控えるデータセットの代わりを作る
 * @param broken 書くと投げるか
 * @returns データセットの代わり
 */
function dataset(broken = false): FakeDataset {
  const fake: FakeDataset = {
    points: [],
    writeDataPoint(point) {
      if (broken) throw new Error("書けない");
      if (point) fake.points.push(point);
    },
  };
  return fake;
}

/**
 * 見本のアプリ。/broken は 500、/busy は 503、/missing は 404、/throw は投げ、ほかは 200 を返す
 * @param request 受けた要求
 * @returns 応え
 */
async function app(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/throw") throw new Error("落ちた");
  const status = { "/broken": 500, "/busy": 503, "/missing": 404 }[path] ?? 200;
  return new Response("ok", { status });
}

/**
 * ブラウザーがページを開く要求を作る
 * @param path 開くパス
 * @param referer Referer。null なら付けない
 * @returns 要求
 */
function navigate(path: string, referer: string | null): Request {
  const headers: Record<string, string> = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };
  if (referer !== null) headers["referer"] = referer;
  return new Request(`https://sample.example.com${path}`, { headers });
}

/**
 * ページの中から呼ぶ要求 (fetch) を作る
 * @param path 呼ぶパス
 * @returns 要求
 */
function fetchFromPage(path: string): Request {
  return new Request(`https://sample.example.com${path}`, { headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", referer: "https://sample.example.com/" } });
}

const env = (points: RequestsDataset | undefined, name: string | undefined = "know-sample") => ({ REQUESTS: points, WORKER_NAME: name });

describe("サービスの種類", () => {
  describe("訪問の決め方", () => {
    it("共有の型は、ページを開いた訪問とアプリが返した 5xx だけを共通のデータセットに書き、書けなくても応えを変えない", async () => {
      expect(isVisitNavigation(navigate("/", null))).toBe(true);
      expect(isVisitNavigation(navigate("/", "https://search.example.org/?q=1"))).toBe(true);
      // 同じサイトの中の移り、ページの中の呼び出し、POST のフォーム、形の違う Referer は訪問に数えない
      expect(isVisitNavigation(navigate("/about", "https://sample.example.com/"))).toBe(false);
      expect(isVisitNavigation(fetchFromPage("/api/items"))).toBe(false);
      expect(isVisitNavigation(new Request("https://sample.example.com/form", { method: "POST", headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } }))).toBe(false);
      expect(isVisitNavigation(navigate("/", "not a url"))).toBe(false);
      // iframe に入った読み込みと、Sec-Fetch の無い要求 (curl など) は訪問に数えない
      expect(isVisitNavigation(new Request("https://sample.example.com/", { headers: { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" } }))).toBe(false);
      expect(isVisitNavigation(new Request("https://sample.example.com/"))).toBe(false);
      const points = dataset();
      const handler = countRequests(app);
      await handler(navigate("/", null), env(points), {});
      await handler(navigate("/about", "https://sample.example.com/"), env(points), {});
      expect(points.points).toEqual([{ indexes: ["know-sample"], blobs: ["know-sample"], doubles: [1, 0] }]);
    });
  });

  describe("アプリが返した 5xx", () => {
    it("共有の型は、ページを開いた訪問とアプリが返した 5xx だけを共通のデータセットに書き、書けなくても応えを変えない", async () => {
      expect([500, 599, 499, 600, 429, 401].map((status) => isServerError(status))).toEqual([true, true, false, false, false, false]);
      const points = dataset();
      const handler = countRequests(app);
      expect((await handler(fetchFromPage("/broken"), env(points), {})).status).toBe(500);
      expect((await handler(navigate("/busy", null), env(points), {})).status).toBe(503);
      expect((await handler(fetchFromPage("/missing"), env(points), {})).status).toBe(404);
      expect((await handler(fetchFromPage("/"), env(points), {})).status).toBe(200);
      expect(points.points).toEqual([
        { indexes: ["know-sample"], blobs: ["know-sample"], doubles: [0, 1] },
        { indexes: ["know-sample"], blobs: ["know-sample"], doubles: [1, 1] },
      ]);
    });
  });

  describe("アプリが投げた失敗", () => {
    it("共有の型は、ページを開いた訪問とアプリが返した 5xx だけを共通のデータセットに書き、書けなくても応えを変えない", async () => {
      // 投げた失敗は Workers の errors に入るので、5xx に数えると二重になる
      const points = dataset();
      await expect(countRequests(app)(navigate("/throw", null), env(points), {})).rejects.toThrow("落ちた");
      expect(points.points).toEqual([]);
    });
  });

  describe("アプリが替えた訪問の決め方", () => {
    it("共有の型は、ページを開いた訪問とアプリが返した 5xx だけを共通のデータセットに書き、書けなくても応えを変えない", async () => {
      const points = dataset();
      const handler = countRequests(app, { visit: (request) => request.headers.get("x-visit") === "1" });
      await handler(new Request("https://sample.example.com/api", { headers: { "x-visit": "1" } }), env(points), {});
      // 替えた時は、ページを直に開いても訪問に数えない
      await handler(navigate("/", null), env(points), {});
      expect(points.points).toEqual([{ indexes: ["know-sample"], blobs: ["know-sample"], doubles: [1, 0] }]);
    });
  });

  describe("バインディングとスクリプト名が無い時と書けない時", () => {
    it("共有の型は、ページを開いた訪問とアプリが返した 5xx だけを共通のデータセットに書き、書けなくても応えを変えない", async () => {
      const handler = countRequests(app);
      const points = dataset();
      expect((await handler(navigate("/", null), { REQUESTS: points }, {})).status).toBe(200);
      expect((await handler(navigate("/", null), env(points, ""), {})).status).toBe(200);
      expect(points.points).toEqual([]);
      expect((await handler(navigate("/broken", null), env(undefined), {})).status).toBe(500);
      const errors: unknown[] = [];
      const failing = countRequests(app, { onWriteError: (error) => errors.push(error) });
      const res = await failing(navigate("/", null), env(dataset(true)), {});
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(errors).toHaveLength(1);
    });
  });

  describe("wrangler の雛形", () => {
    it("共有の型は、ページを開いた訪問とアプリが返した 5xx だけを共通のデータセットに書き、書けなくても応えを変えない", () => {
      const text = readFileSync(join(import.meta.dirname, "../wrangler.template.jsonc"), "utf8").replaceAll(/^\s*\/\/.*$/gm, "");
      const config: unknown = JSON.parse(text);
      const datasets = [{ binding: "REQUESTS", dataset: REQUESTS_DATASET }];
      // WORKER_NAME は name と同じ。プレビューの点が本番の数に混ざらないよう、プレビューは別の名前で書く
      expect(config).toEqual({
        name: "<name>",
        vars: { WORKER_NAME: "<name>" },
        analytics_engine_datasets: datasets,
        previews: { vars: { WORKER_NAME: "<name>-preview" }, analytics_engine_datasets: datasets },
      });
    });
  });
});
