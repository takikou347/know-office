// 社員のツールを MCP の受け手に出す時の説明と入力の形が、ゲートウェイの正本の形と食い違わない事を確かめる (社員が考えるの 3.5)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ROLE_TOOLS, STAFF_TOOL_CATALOG, STAFF_TOOL_NAMES, StaffRequestTool } from "../src/index.ts";

describe("社員のツールの説明と入力の形", () => {
  it("社員のツールの名前はどれも説明と入力の形を持ち、役の一覧は社員のツールだけを並べる", () => {
    expect(Object.keys(STAFF_TOOL_CATALOG).toSorted()).toEqual([...STAFF_TOOL_NAMES].toSorted());
    expect(Object.values(STAFF_TOOL_CATALOG).every((e) => e.description !== "" && Object.keys(e.shape).length > 0)).toBe(true);
    const listed: readonly string[] = STAFF_TOOL_NAMES;
    expect(Object.values(ROLE_TOOLS).flat().filter((name) => !listed.includes(name))).toEqual([]);
  });

  it("staff_request の平らにした形を通った正しい入力は、正本の共用体も通す", () => {
    const flat = z.object(STAFF_TOOL_CATALOG.staff_request.shape).strict();
    for (const input of [
      { kind: "staff_add", role: "デザイン担当", bossId: "president", reason: "画面の直しが溜まっている" },
      { kind: "role_change", target: "builder", role: "開発担当", bossId: null, reason: "上司を外す" },
    ]) {
      expect(flat.safeParse(input).success).toBe(true);
      expect(StaffRequestTool.safeParse(input).success).toBe(true);
    }
  });
});
