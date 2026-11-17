// ゲートウェイの設定 (環境変数、秘密、バインディング) を一度に確かめる (ログインと記録の 3.8)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEnv } from "../../src/gate/config.ts";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

let d1: TestD1;
let gate: TestGate;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock: fixedClock(Date.UTC(2026, 10, 14, 3, 0, 0)), d1 });
});
afterEach(() => d1.dispose());

describe("設定を確かめる", () => {
  it("そろった設定では、足りない物が無い", () => {
    expect(checkEnv(gate.env)).toEqual([]);
  });

  it("無い項目、空の項目、形の違う項目、無いバインディングの名前だけを、名前の順に返す", () => {
    const env = { ...gate.env, ACCESS_TEAM: "", ACCESS_AUD: undefined, MASTER_KEY: btoa("16 bytes only!!!"), URGENT_SCAN: "yes", FILES: undefined, OFFICE_REPO: "no-slash" };
    expect(checkEnv(env)).toEqual(["ACCESS_AUD", "ACCESS_TEAM", "FILES", "MASTER_KEY", "OFFICE_REPO", "URGENT_SCAN"]);
  });
});
