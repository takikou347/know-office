// 見本の Web アプリのサービス。管理するサービスのリポジトリと同じく、共有の型 (@know-office/requests) で Worker の fetch を包み、訪問と 5xx を共通のデータセットに書く (サービスと拡張の 3.2)
import { countRequests, type RequestsDataset } from "@know-office/requests";
import { Hono } from "hono";

/** Workers のスクリプト名の形 (英数字と - の 63 字まで、頭と終わりに - を置かない)。office が読む名前と同じ */
const SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** 見本のアプリ。/ は説明への道と、壊れた API を呼ぶボタンを持つ。/api/broken はアプリが返す 500 */
const sample = new Hono()
  .get("/", (c) =>
    c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>見本の Web アプリ</title></head><body><main><h1>見本の Web アプリ</h1>` +
        `<a href="about">説明</a> <button type="button" id="broken">壊れた API を呼ぶ</button><p role="status" id="result"></p></main>` +
        `<script>document.getElementById("broken").addEventListener("click", async () => { const res = await fetch("api/broken"); document.getElementById("result").textContent = String(res.status); });</script></body></html>`,
    ),
  )
  .get("/about", (c) => c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>説明</title></head><body><main><h1>見本の Web アプリの説明</h1></main></body></html>`))
  .get("/api/broken", () => {
    // Hono が投げた失敗を 500 の応えに直すので、共有の型はアプリが返した 5xx として数える
    throw new Error("見本の失敗");
  });

/** 共有の型で包んだ見本のアプリ */
const counted = countRequests(sample.fetch);

/**
 * 見本の Web アプリを、/sample-app/<スクリプト名>/ の下に立てる。デプロイした Worker の名前 (WORKER_NAME) を道から受け、通しごとに別のスクリプトにできる
 * @param dataset 点を書く共通のデータセットの代わり
 * @returns 見本のアプリを持つ Hono
 */
export function createSampleApp(dataset: RequestsDataset): Hono {
  return new Hono().all("/:script/*", async (c) => {
    const script = c.req.param("script");
    if (!SCRIPT_NAME.test(script)) return c.text("not found", 404);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(`/sample-app/${script}`.length) || "/";
    return counted(new Request(url, c.req.raw), { REQUESTS: dataset, WORKER_NAME: script }, undefined);
  });
}
