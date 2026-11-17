import { describe, expect, it } from "vitest";
import { describeEvent, newsOf, officeEventOf } from "../../src/screen/pages/office/events.ts";

// 配信で届いた仕事の出来事を、オフィスで見せる出来事にして読み上げる。画面の全体の 3.2

const roleOf = (id: string) => ({ president: "社長", builder: "作る役", reviewer: "見る役", owner: "オーナー" })[id] ?? id;

const work = { nodeId: "019a7b00-0000-7000-8000-0000000000a1", title: "勤怠の表" };

describe("出来事", () => {
  it("仕事の出来事の 4 つの種類を、渡す、レビューを頼む、承認、差し戻しにする", () => {
    const task = { taskId: work.nodeId, title: "勤怠の表" };
    expect(officeEventOf({ ...work, action: "assign", from: "president", to: "builder" })).toEqual({ kind: "assign", ...task, from: "president", to: "builder" });
    expect(officeEventOf({ ...work, action: "review-request", from: "builder", to: "reviewer" })).toEqual({ kind: "review-request", ...task, from: "builder", to: "reviewer" });
    expect(officeEventOf({ ...work, action: "approve", from: "owner", to: "builder" })).toEqual({ kind: "approve", ...task, by: "owner", owner: "builder" });
    expect(officeEventOf({ ...work, action: "send-back", from: "reviewer", to: "builder" })).toEqual({ kind: "send-back", ...task, by: "reviewer", to: "builder" });
  });

  it("オーナーが出した出来事はオーナーとして読み上げる", () => {
    expect(describeEvent(officeEventOf({ ...work, action: "send-back", from: "owner", to: "builder" }), roleOf)).toBe("オーナーが「勤怠の表」を作る役に差し戻した");
  });

  it("出来事を読み上げる文にする", () => {
    expect(describeEvent({ kind: "assign", taskId: "t9", title: "通知を作る", from: "president", to: "builder" }, roleOf)).toBe(
      "社長が作る役に「通知を作る」を渡した",
    );
    expect(describeEvent({ kind: "review-request", taskId: "t1", title: "A", from: "builder", to: "reviewer" }, roleOf)).toBe(
      "作る役が見る役に「A」のレビューを頼んだ",
    );
    expect(describeEvent({ kind: "approve", taskId: "t2", title: "B", by: "reviewer", owner: "builder" }, roleOf)).toBe("見る役が「B」を承認した");
    expect(describeEvent({ kind: "send-back", taskId: "t2", title: "B", by: "reviewer", to: "builder" }, roleOf)).toBe(
      "見る役が「B」を作る役に差し戻した",
    );
    expect(describeEvent({ kind: "state", staffId: "builder", from: "working", to: "off" }, roleOf)).toBe("作る役が退勤した");
  });
});

/**
 * 承認の出来事を作る
 * @param title タスクの題
 * @returns 承認の出来事
 */
const approve = (title: string) => ({ kind: "approve" as const, taskId: title, title, by: "reviewer", owner: "builder" });

describe("オフィスの部屋", () => {
  it("まとまりの出来事を全部読み上げる", () => {
    expect(newsOf([approve("A")], roleOf)).toBe("直近の出来事: 見る役が「A」を承認した");
    // 2 件は、どちらも読み上げる
    expect(newsOf([approve("A"), approve("B")], roleOf)).toBe("直近の出来事: 見る役が「A」を承認した。見る役が「B」を承認した");
    // 上限ちょうどの 3 件は、全部を読み上げる
    expect(newsOf([approve("A"), approve("B"), approve("C")], roleOf)).toBe(
      "直近の出来事: 見る役が「A」を承認した。見る役が「B」を承認した。見る役が「C」を承認した",
    );
    // 3 件を超えたら、初めの 3 件と、ほかの件数を読み上げる
    expect(newsOf([approve("A"), approve("B"), approve("C"), approve("D"), approve("E")], roleOf)).toBe(
      "直近の出来事: 見る役が「A」を承認した。見る役が「B」を承認した。見る役が「C」を承認した。ほか 2 件",
    );
    // 出来事が無ければ、まだ無い事を読み上げる
    expect(newsOf([], roleOf)).toBe("直近の出来事はまだありません");
  });
});
