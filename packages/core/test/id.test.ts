// ID と時刻と JSON の正規化を確かめる。05-conventions.md の 1 章
import { describe, expect, it } from "vitest";
import { canonicalJson, jstClock, jstDay, jstYear, newId, sha256Hex } from "../src/index.ts";

const clock = { now: () => Date.UTC(2026, 10, 14, 15, 30, 0) };

describe("共通の道具", () => {
  it("newId は時刻を頭に持つ UUID v7 を返し、後に作った物ほど大きい", () => {
    const a = newId(clock);
    const b = newId({ now: () => clock.now() + 1 });
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(a.replaceAll("-", "").slice(0, 12), 16)).toBe(clock.now());
    expect(b > a).toBe(true);
  });

  it("日本時間の日と時刻と年を返す", () => {
    expect(jstDay(clock.now())).toBe("2026-11-15");
    expect(jstClock(clock.now())).toBe("00:30");
    expect(jstYear(Date.UTC(2026, 11, 31, 15, 0, 0))).toBe(2027);
  });

  it("canonicalJson はキーを並べ替え、入れ子も同じにする", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  });

  it("sha256Hex は 64 桁の 16 進数を返す", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
