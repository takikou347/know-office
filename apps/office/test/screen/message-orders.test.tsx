// 会話の発言の下に出す、会話の言葉から足した指示の文と取り消すボタン (社員と勤怠の 3.4)
import type { StaffOverview } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiContext, createApi } from "../../src/screen/api.ts";
import { MessageOrders } from "../../src/screen/pages/staff/MessageOrders.tsx";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 文と役の名前しか読まない
const STAFF = { id: "reviewer", role: "レビュー担当" } as StaffOverview;
const ID = "0190f4a8-0000-7000-8000-000000000001";

/**
 * 入口の口を付けて描く
 * @param orders 指示
 * @returns HTML
 */
function draw(orders: Parameters<typeof MessageOrders>[0]["orders"]): string {
  const api = createApi("http://localhost", () => Promise.resolve(Response.json({})));
  return renderToString(
    <ApiContext.Provider value={api}>
      <MessageOrders staff={STAFF} orders={orders} />
    </ApiContext.Provider>,
  );
}

describe("会話の言葉の指示の表示", () => {
  it("足した指示は日と時刻を付けて出し、効いている物だけに取り消すボタンを出す", () => {
    const html = draw([
      { id: ID, kind: "leave_early", day: "2026-12-01", until: "15:00", cancelledAt: null },
      { id: "0190f4a8-0000-7000-8000-000000000002", kind: "off", day: "2026-12-02", until: null, cancelledAt: "2026-12-01T03:00:00.000Z" },
    ]);
    expect(html).toContain("12/1 の早退を 15:00 までで出しました");
    expect(html).toContain('aria-label="早退の指示を取り消す"');
    expect(html).toContain("12/2 を休みにしました (取り消しました)");
    expect(html).not.toContain('aria-label="休みの指示を取り消す"');
    // 取り消しの結果を読み上げる入れ物は先に置く
    expect(html).toContain('role="status"');
  });

  it("確かめていない延長は、ボタンから出す案内を出す", () => {
    const html = draw([{ kind: "extend", day: "2026-12-01", until: "19:00", skipped: "step_up_required" }]);
    expect(html).toContain("12/1 の延長 (19:00 まで) はパスキーの確認が要るので出していません。指示のボタンから出してください");
    expect(html).not.toContain("取り消す");
  });

  it("指示が無ければ何も出さない", () => {
    expect(draw([])).toBe("");
  });
});
