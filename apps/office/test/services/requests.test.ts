// know-office のゲートウェイが、画面の知らせた訪問を Workers Analytics Engine に 1 点ずつ書く (サービスと拡張の 3.2)
import { readFileSync } from "node:fs";
import type { AnalyticsEngineDataPoint, AnalyticsEngineDataset } from "@cloudflare/workers-types";
import { join } from "node:path";
import { VISIT_HEADER } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REQUESTS_DATASET } from "../../src/gate/services/requests.ts";
import { useWork } from "../helpers/work.ts";

const world = useWork();

/** 書いた点を控える、Analytics Engine のデータセットの代わり */
type FakeDataset = AnalyticsEngineDataset & { points: AnalyticsEngineDataPoint[] };

/**
 * 書いた点を控えるデータセットの代わりをゲートウェイにつなぐ
 * @param options 入れる Worker の名前と、書くと投げるか
 * @param options.workerName ゲートウェイに入れる Worker の名前。null なら入れない
 * @param options.broken 書くと投げるか
 * @returns データセットの代わり
 */
function connect(options: { workerName?: string | null; broken?: boolean } = {}): FakeDataset {
  const dataset: FakeDataset = {
    points: [],
    writeDataPoint(point) {
      if (options.broken) throw new Error("書けない");
      if (point) dataset.points.push(point);
    },
  };
  const workerName = options.workerName === undefined ? "know-office" : options.workerName;
  Object.assign(world.gate.env, { REQUESTS: dataset, ...(workerName === null ? {} : { WORKER_NAME: workerName }) });
  return dataset;
}

/**
 * ログインしたまま API を呼ぶ
 * @param headers 足すヘッダー
 * @returns 返事
 */
function call(headers: Record<string, string> = {}): Promise<Response> {
  return world.gate.request("/api/v1/notices", { headers: { ...world.headers, ...headers } });
}

describe("サービスの種類", () => {
  it("ログインを通った API の呼び出しが訪問と知らせた時だけ、訪問として 1 点書く", async () => {
    const dataset = connect();
    expect((await call({ [VISIT_HEADER]: "1" })).status).toBe(200);
    // 訪問でない呼び出しには点を書かない
    expect((await call()).status).toBe(200);
    expect(dataset.points).toEqual([{ indexes: ["know-office"], blobs: ["know-office"], doubles: [1] }]);
  });

  it("訪問の知らせの形が違うか、ログインを通らない呼び出しは訪問に数えない", async () => {
    const dataset = connect();
    for (const value of ["0", "true", "11", "https://example.com/"]) expect((await call({ [VISIT_HEADER]: value })).status).toBe(200);
    // ログインセッションが無い呼び出しは 401 で、知らせを受けない
    const denied = await world.gate.request("/api/v1/notices", { headers: { [VISIT_HEADER]: "1" } });
    expect(denied.status).toBe(401);
    expect(dataset.points).toEqual([]);
  });

  it("Analytics Engine のバインディングかスクリプト名が無い間は、何も書かずに応える", async () => {
    const dataset = connect({ workerName: null });
    expect((await call({ [VISIT_HEADER]: "1" })).status).toBe(200);
    expect(dataset.points).toEqual([]);
    Object.assign(world.gate.env, { REQUESTS: undefined, WORKER_NAME: "know-office" });
    expect((await call({ [VISIT_HEADER]: "1" })).status).toBe(200);
  });

  it("点を書けなくても API の応えは変えない", async () => {
    connect({ broken: true });
    const res = await call({ [VISIT_HEADER]: "1" });
    expect(res.status).toBe(200);
    expect(z.object({ data: z.array(z.unknown()) }).loose().safeParse(await res.json()).success).toBe(true);
  });

  it("書くスクリプト名は wrangler の name と同じで、プレビューは別の名前にする", () => {
    const Dataset = z.array(z.object({ binding: z.literal("REQUESTS"), dataset: z.literal(REQUESTS_DATASET) }).strict()).length(1);
    const Vars = z.object({ WORKER_NAME: z.string() }).loose();
    const config = z
      .object({ name: z.string(), vars: Vars, analytics_engine_datasets: Dataset, previews: z.object({ vars: Vars, analytics_engine_datasets: Dataset }).loose() })
      .loose()
      .parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8").replaceAll(/^\s*\/\/.*$/gm, "")));
    expect(config.vars.WORKER_NAME).toBe(config.name);
    // プレビューの点が本番の know-office の数に混ざらないよう、別の名前で書く
    expect(config.previews.vars.WORKER_NAME).not.toBe(config.name);
  });
});
