// 会話の発言の下に出す、社長が分けるタスクにした印とタスクへの道、社長の会話の説明 (タスクとレビューの 3.1 の 7、社員が考えるの 3.9)
import type { StaffOverview } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiContext, createApi } from "../../src/screen/api.ts";
import { OwnerBody, talkHint } from "../../src/screen/pages/staff/Talk.tsx";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 社員 ID と役の名前しか読まない
const PRESIDENT = { id: "president", role: "社長" } as StaffOverview;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 社員 ID と役の名前しか読まない
const REVIEWER = { id: "reviewer", role: "レビュー担当" } as StaffOverview;
const TASK = "0190f4a8-0000-7000-8000-0000000000a1";

/**
 * 入口の口を付けて発言の本文を描く
 * @param props 発言の本文の props
 * @returns HTML
 */
function draw(props: Parameters<typeof OwnerBody>[0]): string {
  const api = createApi("http://localhost", () => Promise.resolve(Response.json({})));
  return renderToString(
    <ApiContext.Provider value={api}>
      <OwnerBody {...props} />
    </ApiContext.Provider>,
  );
}

describe("社長が分けるタスクにした発言の表示", () => {
  it("タスクにした発言は印とタスクの詳細への道を出す", () => {
    const html = draw({ staff: PRESIDENT, body: "勤怠を週ごとにも見たい", delivery: { via: "task", taskId: TASK }, orders: [] });
    expect(html).toContain("社長のタスクにしました");
    expect(html).toContain(`href="/staff/president/tasks/${TASK}"`);
    expect(html).toContain("分けるタスクを開く");
  });

  it("ほかの道の発言には道を出さない", () => {
    const html = draw({ staff: REVIEWER, body: "テストも足して", delivery: { via: "run", taskId: null }, orders: [] });
    expect(html).toContain("社員に渡しました");
    expect(html).not.toContain("分けるタスクを開く");
    expect(draw({ staff: REVIEWER, body: "次は記録", delivery: null, orders: [] })).toContain("次のタスクで渡します");
  });

  it("社長の会話の説明は、走っていない時にタスクにする事を伝える", () => {
    expect(talkHint(PRESIDENT)).toBe("社長が作業中なら今の作業に渡します。作業していない時は、社長が分けるタスクとして仕事の山に足します。渡すまで最長 1 分かかります");
    expect(talkHint(REVIEWER)).toBe("タスク中なら今の作業に渡します。タスクの外なら次のタスクの頭で渡します。渡すまで最長 1 分かかります");
  });
});
