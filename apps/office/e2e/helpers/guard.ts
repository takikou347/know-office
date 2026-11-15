// セキュリティの画面の効き目と蒸留の案を、境目のモックで返す。ルートそのものは test/guard/lessons.test.ts で確かめる (サービスと拡張の 3.6)
import type { Page } from "@playwright/test";

const META = { traceId: "0".repeat(32) };
const APPLIED = "0190f4a8-0000-7000-8000-0000000000a1";
const PROPOSED = "0190f4a8-0000-7000-8000-0000000000a2";

/**
 * 蒸留の案を 1 件作る
 * @param id 案の ID
 * @param status 状態
 * @param proposal 案
 * @returns 返す形の案
 */
function lesson(id: string, status: string, proposal: string) {
  return { id, createdAt: "2026-12-07T00:00:00.000Z", kind: "prompt_rule", cause: "staff_rule_denied", proposal, staffId: "builder", stopIds: [], status };
}

/**
 * 自動停止の効き目と蒸留の案を、境目のモックで返す。ルートそのものは test/guard/lessons.test.ts で確かめる
 * @param page 開くページ
 * @param decisions 決めた要求を並べる先
 */
export async function withGuardLearning(page: Page, decisions: unknown[] = []): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/v1/guard/effect",
    (route) =>
      route.fulfill({
        json: {
          data: { stops: 9, falseRatio: 0.4, topCauses: [{ signal: "staff_rule_denied", count: 7 }, { signal: "token_rate", count: 2 }], measures: [{ lessonId: APPLIED, before: 4, after: 1 }] },
          meta: META,
        },
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/v1/guard/lessons",
    (route) => route.fulfill({ json: { data: [lesson(PROPOSED, "proposed", "main に push しない"), lesson(APPLIED, "applied", "push の前にブランチを確かめる")], meta: { ...META, next: null } } }),
  );
  await page.route(`**/api/v1/guard/lessons/${PROPOSED}/decision`, async (route) => {
    decisions.push(route.request().postDataJSON());
    await route.fulfill({ json: { data: lesson(PROPOSED, "applied", "main に push しない"), meta: META } });
  });
}
