// タスクの出来事から、オフィスで見せる仕事の出来事を決める。社員でない者はオーナーにし、相手の決まらない出来事は見せない (画面の全体の 3.2)
import { describe, expect, it } from "vitest";
import { officeWorkOf, type WorkRow } from "../../src/gate/work/office-work.ts";

const task: WorkRow = { id: "019a7b00-0000-7000-8000-0000000000a1", kind: "task", title: "勤怠の表", assignee: "builder", taskKind: "build" };

describe("オフィスの出来事の決め方", () => {
  it("頼む先の変わらない直しと、頼む先を外す直しは見せない", () => {
    expect(officeWorkOf({ kind: "updated", staffId: null, assigned: { from: "builder", to: "builder" } }, task)).toBeNull();
    expect(officeWorkOf({ kind: "updated", staffId: null, assigned: { from: "builder", to: null } }, { ...task, assignee: null })).toBeNull();
    expect(officeWorkOf({ kind: "updated", staffId: null }, task)).toBeNull();
  });

  it("ゲートウェイと GitHub で出た判断はオーナーの側にする", () => {
    expect(officeWorkOf({ kind: "owner_approved", staffId: null }, task)).toEqual({ nodeId: task.id, title: "勤怠の表", action: "approve", from: "owner", to: "builder" });
    expect(officeWorkOf({ kind: "created", staffId: null }, task)).toMatchObject({ action: "assign", from: "owner" });
  });

  it("担当の無いタスクの承認と差し戻し、レビューのタスクを作った時、タスクでない物、ほかの出来事は見せない", () => {
    const loose = { ...task, assignee: null };
    expect(officeWorkOf({ kind: "review_rejected", staffId: "reviewer" }, loose)).toBeNull();
    expect(officeWorkOf({ kind: "review_approved", staffId: "reviewer" }, loose)).toBeNull();
    expect(officeWorkOf({ kind: "created", staffId: null }, { ...task, taskKind: "review", assignee: "reviewer" })).toBeNull();
    expect(officeWorkOf({ kind: "created", staffId: null }, { ...task, kind: "project", taskKind: null })).toBeNull();
    expect(officeWorkOf({ kind: "started", staffId: "builder" }, task)).toBeNull();
  });
});
