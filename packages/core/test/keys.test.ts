// MASTER_KEY から用途ごとの鍵を作る事を確かめる。詳細設計の目次の 3.3
import { describe, expect, it } from "vitest";
import { deriveKey } from "../src/index.ts";

const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const text = new TextEncoder().encode("秘密");

/**
 * 鍵で暗号にして、もう 1 つの鍵で戻せるかを返す
 * @param a 暗号にする鍵
 * @param b 戻す鍵
 * @returns 戻せたら true
 */
async function roundTrip(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const iv = new Uint8Array(12);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, a, text);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, b, sealed).then(
    () => true,
    () => false,
  );
}

describe("鍵", () => {
  it("同じ用途なら同じ鍵、違う用途なら違う鍵を作る", async () => {
    expect(await roundTrip(await deriveKey(master, "vault"), await deriveKey(master, "vault"))).toBe(true);
    expect(await roundTrip(await deriveKey(master, "vault"), await deriveKey(master, "transcript"))).toBe(false);
  });

  it("同じ用途でも、タスクごとに違う鍵を作る", async () => {
    const a = await deriveKey(master, "transcript", "0190f4a8-0000-7000-8000-000000000101");
    expect(await roundTrip(a, await deriveKey(master, "transcript", "0190f4a8-0000-7000-8000-000000000101"))).toBe(true);
    expect(await roundTrip(a, await deriveKey(master, "transcript", "0190f4a8-0000-7000-8000-000000000102"))).toBe(false);
    expect(await roundTrip(a, await deriveKey(master, "transcript"))).toBe(false);
  });

  it("MASTER_KEY が 32 バイトでなければ断る", async () => {
    await expect(deriveKey(btoa("short"), "vault")).rejects.toThrow("32 バイト");
  });
});
