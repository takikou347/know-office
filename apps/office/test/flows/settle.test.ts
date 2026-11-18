// 利用場面の通しの後始末 (e2e/flows/helpers/settle.ts)。後始末が落ちても本体の最初のエラーを隠さず、後始末はすべて走らせる
import { describe, expect, it } from "vitest";
import { settle } from "../../e2e/flows/helpers/settle.ts";

/**
 * 1 つ目が落ち、2 つ目が通る後始末を作る
 * @param ran 走った後始末の名前を足す先
 * @returns 後始末
 */
function failingUndo(ran: string[]): (() => void)[] {
  return [
    () => {
      ran.push("a");
      throw new Error("戻しが落ちた");
    },
    () => void ran.push("b"),
  ];
}

describe("通しの後始末", () => {
  it("本体が落ちて後始末も落ちた時は、本体のエラーを投げ、後始末のエラーを cause に残す", async () => {
    const ran: string[] = [];
    const first = new Error("本体が落ちた");
    const thrown = await settle(() => Promise.reject(first), failingUndo(ran)).catch((error: unknown) => error);
    expect(thrown).toBe(first);
    expect(ran).toEqual(["a", "b"]);
    expect(first.cause instanceof AggregateError ? first.cause.errors : null).toEqual([new Error("戻しが落ちた")]);
  });

  it("本体が通って後始末が落ちた時は、後始末をすべて走らせてから後始末のエラーを投げる", async () => {
    const ran: string[] = [];
    await expect(settle(() => Promise.resolve(), failingUndo(ran))).rejects.toThrow("戻しが落ちた");
    expect(ran).toEqual(["a", "b"]);
  });

  it("本体も後始末も通れば何も投げない", async () => {
    const ran: string[] = [];
    await settle(() => Promise.resolve(), [() => void ran.push("a")]);
    expect(ran).toEqual(["a"]);
  });
});
