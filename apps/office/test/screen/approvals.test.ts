// 承認を決める画面の、種類ごとの説明と決める所。種類を足した時に説明の抜けで落ちる (タスクとレビューの 3.1)
import { APPROVAL_KIND_LABEL, ApprovalKind } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { approvalDetails, approvalTitle, decideHref, KIND_NOTE, KIND_PLACE, STEP_UP_KINDS } from "../../src/screen/pages/approvals/kinds.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000001";

describe("承認を決める画面の種類", () => {
  it("知っている種類はどれも、名前、説明、決める所を持つ", () => {
    const kinds = ApprovalKind.options.toSorted();
    expect(kinds).toHaveLength(9);
    expect(Object.keys(APPROVAL_KIND_LABEL).toSorted()).toEqual(kinds);
    expect(Object.keys(KIND_NOTE).toSorted()).toEqual(kinds);
    expect(Object.keys(KIND_PLACE).toSorted()).toEqual(kinds);
    for (const kind of kinds) expect(KIND_NOTE[kind]).not.toBe("");
  });

  it("パスキーで確かめる種類は、説明にそう書き、この画面で決める", () => {
    expect([...STEP_UP_KINDS].toSorted()).toEqual(["cost_increase", "external_integration"]);
    for (const kind of STEP_UP_KINDS) {
      expect(KIND_NOTE[kind]).toContain("承認する前にパスキーで確かめます");
      expect(KIND_PLACE[kind]).toBe("here");
    }
  });

  it("役の変更の見出しは社員の名前にし、中身は新しい役と上司と理由を出す", () => {
    expect(approvalTitle({ kind: "role_change", target: "builder" })).toBe("役の変更: 開発担当");
    expect(approvalTitle({ kind: "external_integration", target: "Slack" })).toBe("外部連携: Slack");
    expect(approvalDetails({ kind: "role_change", payload: { role: "開発と運用", bossId: null, reason: "任せる" } })).toEqual(["新しい役: 開発と運用、上司: 無し", "理由: 任せる"]);
    expect(approvalDetails({ kind: "cost_increase", payload: { reason: 3 } })).toEqual([]);
  });

  it("ほかの画面で決める種類の道は、確かめた ID と決まった道だけから組む", () => {
    expect(decideHref({ kind: "merge", payload: { nodeId: NODE }, requestedBy: "president" })).toBe(`/staff/president/tasks/${NODE}`);
    expect(decideHref({ kind: "merge", payload: { nodeId: "../../evil" }, requestedBy: "president" })).toBeNull();
    expect(decideHref({ kind: "merge", payload: { nodeId: NODE }, requestedBy: "javascript:alert(1)" })).toBeNull();
    expect(decideHref({ kind: "guard_change", payload: {}, requestedBy: "president" })).toBe("/guard");
    expect(decideHref({ kind: "prompt_rule", payload: {}, requestedBy: "president" })).toBe("/guard");
    // デプロイはまだ決める所が無いので、道を出さない
    expect(decideHref({ kind: "deploy", payload: { nodeId: NODE }, requestedBy: "president" })).toBeNull();
    expect(decideHref({ kind: "role_change", payload: { nodeId: NODE }, requestedBy: "president" })).toBeNull();
  });
});
