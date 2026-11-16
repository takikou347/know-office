import { describe, expect, it } from "vitest";
import { type OfficeSnapshot, describeEvent, eventsBetween, newsOf } from "../../src/screen/pages/office/events.ts";

// 画面が持つデータの変化から、オフィスで見せる出来事を決める。画面の全体の 3.2

const base: OfficeSnapshot = {
  staff: [
    { id: "president", state: "working" },
    { id: "builder", state: "working" },
    { id: "reviewer", state: "paused" },
  ],
  tasks: [
    { id: "t1", staffId: "builder", title: "勤怠の表の画面を作る", state: "今" },
    { id: "t2", staffId: "builder", title: "CodeEditor のページを足す", state: "可待ち" },
  ],
};

/**
 * 1 つのタスクだけを変えた写しを作る
 * @param id 変えるタスク
 * @param patch 変える所
 * @returns 変えた写し
 */
const withTask = (id: string, patch: Partial<OfficeSnapshot["tasks"][number]>): OfficeSnapshot => ({
  ...base,
  tasks: base.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
});

const roleOf = (id: string) => ({ president: "社長", builder: "作る役", reviewer: "見る役" })[id] ?? id;

describe("出来事", () => {
  it("変わりが無ければ出来事は無い", () => {
    expect(eventsBetween(base, structuredClone(base))).toEqual([]);
  });

  it("新しいタスクが社長でない社員に付くと、社長が仕事を渡す", () => {
    const next = { ...base, tasks: [...base.tasks, { id: "t9", staffId: "builder", title: "通知を作る", state: "次" as const }] };
    expect(eventsBetween(base, next)).toEqual([{ kind: "assign", taskId: "t9", title: "通知を作る", from: "president", to: "builder" }]);
  });

  it("タスクの担当が替わると、社長が新しい担当に渡す", () => {
    expect(eventsBetween(base, withTask("t1", { staffId: "reviewer" }))).toEqual([
      { kind: "assign", taskId: "t1", title: "勤怠の表の画面を作る", from: "president", to: "reviewer" },
    ]);
  });

  it("社長が自分に付けたタスクは渡さない", () => {
    const next = { ...base, tasks: [...base.tasks, { id: "t9", staffId: "president", title: "目標を分ける", state: "今" as const }] };
    expect(eventsBetween(base, next)).toEqual([]);
  });

  it("タスクが可待ちになると、担当が見る役にレビューを頼む", () => {
    expect(eventsBetween(base, withTask("t1", { state: "可待ち" }))).toEqual([
      { kind: "review-request", taskId: "t1", title: "勤怠の表の画面を作る", from: "builder", to: "reviewer" },
    ]);
  });

  it("可待ちから済になると承認、今か次に戻ると差し戻し", () => {
    expect(eventsBetween(base, withTask("t2", { state: "済" }))).toEqual([
      { kind: "approve", taskId: "t2", title: "CodeEditor のページを足す", by: "reviewer", owner: "builder" },
    ]);
    expect(eventsBetween(base, withTask("t2", { state: "今" }))).toEqual([
      { kind: "send-back", taskId: "t2", title: "CodeEditor のページを足す", by: "reviewer", to: "builder" },
    ]);
  });

  it("社員の状態が変わると、その変わりを出来事にする", () => {
    const next = { ...base, staff: base.staff.map((s) => (s.id === "reviewer" ? { ...s, state: "working" as const } : s)) };
    expect(eventsBetween(base, next)).toEqual([{ kind: "state", staffId: "reviewer", from: "paused", to: "working" }]);
  });

  it("同時に起きた変わりは、タスクの並びの順に出す", () => {
    const next: OfficeSnapshot = {
      ...base,
      tasks: [
        { id: "t1", staffId: "builder", title: "勤怠の表の画面を作る", state: "可待ち" },
        { id: "t2", staffId: "builder", title: "CodeEditor のページを足す", state: "済" },
      ],
    };
    expect(eventsBetween(base, next).map((e) => e.kind)).toEqual(["review-request", "approve"]);
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
