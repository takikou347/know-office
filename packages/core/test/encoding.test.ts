// base64 と base64url の変換を確かめる。外から来た文字列は壊れていても投げずに null を返す
import { describe, expect, it } from "vitest";
import { fromBase64, fromBase64url, toBase64, toBase64url } from "../src/index.ts";

const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);

describe("base64 の変換", () => {
  it("base64 と base64url は往復でき、base64url は記号を置き換えてパディングを付けない", () => {
    expect(toBase64(bytes)).toBe("AAH6+/z9/v8=");
    expect(toBase64url(bytes)).toBe("AAH6-_z9_v8");
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
  });

  it("会話の記録ほどの大きなバイト列も base64 にでき、戻せる", () => {
    const big = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const back = fromBase64(toBase64(big)) ?? new Uint8Array(0);
    // 4MB を toEqual で 1 バイトずつ比べると負荷の高い時に 9 秒かかるので、長さと、最初に違うバイトの位置 (無ければ -1) を見る
    let differs = -1;
    for (let i = 0; i < big.length && differs < 0; i += 1) if (back[i] !== big[i]) differs = i;
    expect({ length: back.length, differs }).toEqual({ length: big.length, differs: -1 });
  });

  it.each(["a", "!!", "AAH6+/z9", "A=A="])("壊れた base64url %s は null", (text) => {
    expect(fromBase64url(text)).toBeNull();
  });

  it.each(["a", "!!", "AAH6-_z9"])("壊れた base64 %s は null", (text) => {
    expect(fromBase64(text)).toBeNull();
  });
});
