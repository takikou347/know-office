// Cloudflare の様子を読むテストの共通。代わりの Cloudflare につなぎ、見るサービスを置き、5 分の区切りを進めて読む
import { createFakeCloudflare, DEV_CLOUDFLARE, type FakeCloudflare } from "../../dev/cloudflare.ts";
import { cloudflareAnalytics } from "../../src/gate/services/analytics.ts";
import { collectMetrics } from "../../src/gate/services/deploys.ts";
import { MINUTE, type WorkWorld } from "./work.ts";

/** 最初に登録した know-office (0006_seed_services.sql) */
export const OFFICE_ID = "00000000-0000-7000-8000-000000000102";
/** 最初に登録した knowidea-ui */
export const UI_ID = "00000000-0000-7000-8000-000000000101";
/** 読む know-office の Web アプリ */
export const SERVICE = { id: OFFICE_ID, repo: "example/know-office", kind: "web_app" };

const BASE = "http://localhost:5199/cloudflare";

/** 代わりの Cloudflare と、つないだ env と fetch と、送った宛先 */
export type CloudflareFakes = { cloudflare: FakeCloudflare; env: WorkWorld["gate"]["env"]; fetch: (url: string, init?: RequestInit) => Promise<Response>; sent: string[] };

/**
 * 代わりの Cloudflare につないだ env と fetch を作る
 * @param world テストの物
 * @param token ゲートウェイに入れる API トークン。無ければ鍵を入れない
 * @returns 代わりの Cloudflare と、つないだ env と fetch
 */
export function connectCloudflare(world: WorkWorld, token: string | null = DEV_CLOUDFLARE.token): CloudflareFakes {
  const cloudflare = createFakeCloudflare({ ...DEV_CLOUDFLARE, now: () => world.clock.now() });
  const sent: string[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    sent.push(url);
    return Promise.resolve(cloudflare.app.request(url.slice(BASE.length), init));
  };
  const keys = token === null ? {} : { CLOUDFLARE_ANALYTICS_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: DEV_CLOUDFLARE.accountId };
  return { cloudflare, env: { ...world.gate.env, ...keys }, fetch, sent };
}

/**
 * 最初の 2 つのサービスにリポジトリを付け、knowidea-ui を Web アプリかコンテンツにする
 * @param world テストの物
 * @param uiKind knowidea-ui の種類
 */
export async function watchServices(world: WorkWorld, uiKind: "web_app" | "content" = "content"): Promise<void> {
  await world.d1.DB.prepare("UPDATE services SET repo = 'example/know-office' WHERE id = ?").bind(OFFICE_ID).run();
  await world.d1.DB.prepare("UPDATE services SET repo = 'example/knowidea-ui', kind = ? WHERE id = ?").bind(uiKind, UI_ID).run();
}

/**
 * 5 分の区切りを進めて、様子を読む
 * @param world テストの物
 * @param fakes 代わりの Cloudflare
 */
export async function collectStep(world: WorkWorld, fakes: CloudflareFakes): Promise<void> {
  world.clock.advance(5 * MINUTE);
  await collectMetrics(fakes.env, cloudflareAnalytics(fakes.env, fakes.fetch), world.clock.now(), world.gate.deps);
}
