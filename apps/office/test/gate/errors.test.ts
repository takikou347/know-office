// 想定外の失敗をエラーログに残す事を確かめる。ログインと記録の 3.8
import { Problem } from "@know-office/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/gate/app.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
});
afterAll(() => d1.dispose());

const clock = fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0));

/**
 * わざと落ちるルートを持つゲートウェイを作る
 * @param message 投げるエラーの文
 * @returns ゲートウェイ
 */
function failing(message: string) {
  const app = createApp({ clock });
  app.get("/api/v1/boom", () => {
    throw new TypeError(message);
  });
  return app;
}

const rows = async () =>
  (await d1.REC_2026.prepare("SELECT source, level, code, message, route, status, fingerprint, trace_id FROM error_events ORDER BY rowid").all()).results;

describe("エラーログ", () => {
  it("500 で error_events に 1 行足し、鍵や中身を残さない", async () => {
    const res = await failing("接続に失敗 secret=abc123 token: ghs_XYZ").request("/api/v1/boom", {}, { DB: d1.DB, REC_2026: d1.REC_2026 });
    expect(res.status).toBe(500);
    const body = Problem.parse(await res.json());
    const [row] = await rows();
    expect(row).toMatchObject({ source: "gate", level: "error", code: "internal", route: "/api/v1/boom", status: 500, trace_id: body.traceId });
    expect(String(row?.["message"])).toContain("TypeError");
    expect(String(row?.["message"])).not.toMatch(/abc123|ghs_XYZ/);
  });

  it("同じ原因は同じ fingerprint にまとまる", async () => {
    await failing("同じ失敗").request("/api/v1/boom", {}, { DB: d1.DB, REC_2026: d1.REC_2026 });
    const all = await rows();
    expect(all.at(-1)?.["fingerprint"]).toBe(all[0]?.["fingerprint"]);
  });

  it("同じ原因が 5 分に 3 回を超えると知らせを出す", async () => {
    await failing("また").request("/api/v1/boom", {}, { DB: d1.DB, REC_2026: d1.REC_2026 });
    await failing("また").request("/api/v1/boom", {}, { DB: d1.DB, REC_2026: d1.REC_2026 });
    const notices = await d1.DB.prepare("SELECT level, kind FROM notices").all();
    expect(notices.results).toEqual([{ level: "warn", kind: "error_burst" }]);
  });

  it("エラーログに書けなくても返事は変わらない", async () => {
    const res = await failing("書けない").request("/api/v1/boom", {}, { DB: d1.DB });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "internal", detail: "想定外のエラーが起きた" });
  });
});
