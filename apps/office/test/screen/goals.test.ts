// 目標の画面の組み立て。目標のカード、タスクの 4 列、期限の出し方 (タスクとレビューの 3.1)
import type { NodeTree } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { boardOf, dayOf, dateOf, dueOf, goalCards } from "../../src/screen/pages/goals/model.ts";

let seq = 0;
/**
 * 木の 1 件を作る
 * @param kind 種類
 * @param more 変える項目
 * @returns 木の 1 件
 */
function node(kind: NodeTree["kind"], more: Partial<NodeTree> = {}): NodeTree {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    kind,
    parentId: null,
    scope: "office",
    title: `${kind} ${String(seq)}`,
    body: "",
    taskKind: kind === "task" ? "build" : null,
    assignee: null,
    branch: null,
    status: "todo",
    priority: 100,
    progress: 0,
    dueDay: null,
    version: 1,
    createdAt: "2026-11-23T00:00:00.000Z",
    updatedAt: "2026-11-23T00:00:00.000Z",
    children: [],
    ...more,
  };
}

describe("目標のカード", () => {
  it("目的の下の目標と受け付けのプロジェクトを並べ、タスクの数と済んだ数を数える", () => {
    const done = node("task", { status: "done" });
    const dropped = node("task", { status: "dropped" });
    const project = node("project", { children: [done, dropped, node("task")] });
    const goal = node("goal", { title: "勤怠を出す", dueDay: "2026-12-24", progress: 0.5, children: [project] });
    const purpose = node("purpose", { title: "自分で回る会社", children: [goal] });
    const intake = node("project", { title: "受け付け", children: [node("task")] });
    const cards = goalCards([purpose, intake]);
    expect(cards.map((c) => [c.goal.title, c.purpose?.title ?? null, c.tasks, c.done])).toEqual([
      ["勤怠を出す", "自分で回る会社", 2, 1],
      ["受け付け", null, 1, 0],
    ]);
  });

  it("目的で絞ると、その目的の目標だけを出す", () => {
    const a = node("purpose", { children: [node("goal")] });
    const b = node("purpose", { children: [node("goal"), node("goal")] });
    expect(goalCards([a, b], b.id)).toHaveLength(2);
  });
});

describe("タスクの 4 列", () => {
  it("状態で未着手、進行中、レビュー、完了に分け、取り消したタスクは出さない", () => {
    const p1 = node("project", {
      children: [node("task", { status: "todo" }), node("task", { status: "stopped" }), node("task", { status: "waiting_owner" }), node("task", { status: "doing" }), node("task", { status: "review" }), node("task", { status: "done" }), node("task", { status: "dropped" })],
    });
    const board = boardOf(node("goal", { children: [p1] }));
    expect(board.map((c) => [c.label, c.tasks.length])).toEqual([
      ["未着手", 3],
      ["進行中", 1],
      ["レビュー", 1],
      ["完了", 1],
    ]);
    expect(board[0]?.tasks[0]?.project.id).toBe(p1.id);
  });

  it("プロジェクトで絞ると、そのプロジェクトのタスクだけを出す", () => {
    const p1 = node("project", { children: [node("task")] });
    const p2 = node("project", { children: [node("task"), node("task")] });
    const board = boardOf(node("goal", { children: [p1, p2] }), p2.id);
    expect(board[0]?.tasks).toHaveLength(2);
  });

  it("受け付けのプロジェクトは、その下のタスクを並べる", () => {
    const intake = node("project", { children: [node("task", { status: "doing" })] });
    expect(boardOf(intake)[1]?.tasks[0]?.project.id).toBe(intake.id);
  });
});

describe("期限", () => {
  it("今日より前は期限切れ、7 日以内は近い、ほかは日付だけ", () => {
    const today = "2026-11-23";
    expect(dueOf("2026-11-22", today)).toEqual({ text: "期限 11/22 (期限切れ)", tone: "error" });
    expect(dueOf("2026-11-30", today)).toEqual({ text: "期限 11/30", tone: "warn" });
    expect(dueOf("2026-12-24", today)).toEqual({ text: "期限 12/24", tone: "neutral" });
    expect(dueOf(null, today)).toBeNull();
  });

  it("済んだ物は期限を過ぎても期限切れにしない", () => {
    expect(dueOf("2026-11-22", "2026-11-23", true)).toEqual({ text: "期限 11/22", tone: "neutral" });
  });

  it("日付の文字と日付の物を行き来する", () => {
    const date = dateOf("2026-02-03");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(1);
    expect(date?.getDate()).toBe(3);
    expect(date ? dayOf(date) : null).toBe("2026-02-03");
    expect(dateOf(null)).toBeNull();
  });
});
