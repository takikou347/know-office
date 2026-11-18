// GitHub と連携していない時に、ルールセットを掛け直す操作を断る (GitHub の連携の 3.3)
import { describe, expect, it } from "vitest";
import { api, MINUTE, useWork } from "../helpers/work.ts";

const world = useWork();

describe("ルールセットを掛け直す", () => {
  it("GitHub と連携していなければ 409 にする", async () => {
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(world.clock.now() + 15 * MINUTE).run();
    expect(await api(world, "POST", "/api/v1/github/rules/apply", undefined, 409)).toMatchObject({ code: "conflict" });
    expect(world.gate.audits.filter((a) => a.action === "github.rules_apply")).toEqual([]);
  });
});
