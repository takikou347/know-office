// セキュリティと設定の画面の、出す文と送り方。基準の値の単位、止めた相手の名前、端末の名前、送れなかった理由の分け方 (自動停止の 3.8、ログインと記録の 3.2)
import { DEFAULT_THRESHOLDS } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { createApi } from "../../src/screen/api.ts";
import { shownValue, storedValue, targetLabel, THRESHOLD_ITEMS, thresholdText } from "../../src/screen/pages/guard/labels.ts";
import { deviceName } from "../../src/screen/pages/settings/Sessions.tsx";
import { send } from "../../src/screen/parts/load.tsx";

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ status, code, traceId: "a".repeat(32) }), { status, headers: { "Content-Type": "application/problem+json" } });

describe("セキュリティの画面の基準", () => {
  it("基準の項目は、core の基準のキーと同じで、抜けも余りも無い", () => {
    expect(THRESHOLD_ITEMS.map((i) => i.key).toSorted()).toEqual(Object.keys(DEFAULT_THRESHOLDS).toSorted());
  });

  it("時間は分、率は % に直して出し、入れた数は元の単位に戻す", () => {
    expect(thresholdText("ms", DEFAULT_THRESHOLDS.taskMaxMs)).toBe("240 分");
    expect(thresholdText("bp", DEFAULT_THRESHOLDS.deployFailureBp)).toBe("5 %");
    expect(thresholdText("count", DEFAULT_THRESHOLDS.repeatedFailures)).toBe("3 回");
    expect(thresholdText("times", DEFAULT_THRESHOLDS.rateMultiplier)).toBe("5 倍");
    expect(thresholdText("days", DEFAULT_THRESHOLDS.baselineDays)).toBe("7 日");
    for (const item of THRESHOLD_ITEMS) {
      const stored = DEFAULT_THRESHOLDS[item.key];
      expect(storedValue(item.unit, shownValue(item.unit, stored))).toBe(stored);
    }
    expect(storedValue("ms", 15)).toBe(900_000);
    expect(storedValue("bp", 2.5)).toBe(250);
    // 掛けた時の端数は残さず、倍率だけは小数のまま置く
    expect(storedValue("ms", 0.1)).toBe(6000);
    expect(storedValue("bp", 0.07)).toBe(7);
    expect(storedValue("times", 2.5)).toBe(2.5);
  });

  it("止めた相手は、社員は役の名前、全体はすべての社員、サービスは名前で出す", () => {
    expect(targetLabel("staff", "builder")).toBe("開発担当");
    expect(targetLabel("office", "office")).toBe("すべての社員");
    expect(targetLabel("service", "s1", new Map([["s1", "knowidea-ui"]]))).toBe("knowidea-ui");
    // 名前を読めないサービスとタスクは、ID を出して見分けられるようにする
    expect(targetLabel("service", "s2")).toBe("サービス s2");
    expect(targetLabel("task", "t1")).toBe("タスク t1");
  });
});

describe("設定の画面のセッション", () => {
  it("User-Agent から端末とブラウザーの名前を作り、分からない時は分からない端末にする", () => {
    expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")).toBe("Mac の Chrome");
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1")).toBe("iPhone の Safari");
    expect(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0")).toBe("Windows の Edge");
    expect(deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Linux の Firefox");
    expect(deviceName("curl/8.5.0")).toBe("分からない端末");
    expect(deviceName("")).toBe("分からない端末");
  });
});

describe("画面からゲートウェイへ送る", () => {
  it("断られた時は、ゲートウェイの code と traceId を返す", async () => {
    const api = createApi("http://localhost", () => Promise.resolve(problem(409, "conflict")));
    const sent = await send(api, () => api.api.v1.guard.thresholds.$put({ json: { version: 0, values: {}, reason: "確かめ" } }));
    expect(sent).toEqual({ ok: false, failure: { code: "conflict", traceId: "a".repeat(32) } });
  });

  it("入口につながらない時は network にする", async () => {
    const api = createApi("http://localhost", () => Promise.reject(new Error("offline")));
    const sent = await send(api, () => api.api.v1.guard.thresholds.$put({ json: { version: 0, values: {}, reason: "確かめ" } }));
    expect(sent).toEqual({ ok: false, failure: { code: "network", traceId: null } });
  });

  it("パスキーで確かめられなかった時は step_up_failed にし、送り直さない", async () => {
    const calls: string[] = [];
    // この環境にはブラウザーの認証器が無いので、challenge を受けた後の確かめで落ちる
    const api = createApi("http://localhost", (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return Promise.resolve(path === "/api/v1/passkeys/options" ? Response.json({ data: { challenge: "c" }, meta: { traceId: "b".repeat(32) } }) : problem(401, "step_up_required"));
    });
    const sent = await send(api, () => api.api.v1.guard.thresholds.$put({ json: { version: 0, values: {}, reason: "確かめ" } }));
    expect(sent).toEqual({ ok: false, failure: { code: "step_up_failed", traceId: null } });
    expect(calls).toEqual(["PUT /api/v1/guard/thresholds", "POST /api/v1/passkeys/options"]);
  });
});
