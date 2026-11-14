// 開発環境の代わりの Access を確かめる。ログインと記録の 3.9
import { z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createFakeAccess } from "../../dev/access.ts";
import { fixedClock } from "../helpers/clock.ts";

const NOW = Date.UTC(2026, 10, 14, 3, 0, 0);
const Certs = z.object({ keys: z.array(z.object({ kty: z.string(), n: z.string(), e: z.string(), kid: z.string(), alg: z.string() })) });

/**
 * 証明の署名を、代わりの Access が出した公開鍵で確かめる
 * @param token 証明
 * @param keys 公開鍵の並び
 * @returns 署名が通れば true
 */
async function verify(token: string, keys: JsonWebKey[]): Promise<boolean> {
  const [head = "", body = "", sig = ""] = token.split(".");
  const key = await crypto.subtle.importKey("jwk", keys[0] ?? {}, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${head}.${body}`));
}

/**
 * 証明の中身を読む
 * @param token 証明
 * @returns ヘッダーとクレーム
 */
function decode(token: string): { header: unknown; claims: unknown } {
  const [head = "", body = ""] = token.split(".");
  return { header: JSON.parse(Buffer.from(head, "base64url").toString()), claims: JSON.parse(Buffer.from(body, "base64url").toString()) };
}

describe("開発環境の代わりの物", () => {
  it("代わりの Access の証明は、公開鍵で署名が通る", async () => {
    const access = await createFakeAccess({ team: "dev", aud: "aud-dev", email: "owner@example.com", clock: fixedClock(NOW) });
    const res = await access.app.request("/cdn-cgi/access/certs");
    const { keys } = Certs.parse(await res.json());
    expect(await verify(await access.sign(), keys)).toBe(true);
  });

  it("書き換えた証明は署名が通らない", async () => {
    const access = await createFakeAccess({ team: "dev", aud: "aud-dev", email: "owner@example.com", clock: fixedClock(NOW) });
    const res = await access.app.request("/cdn-cgi/access/certs");
    const { keys } = Certs.parse(await res.json());
    const [head = "", , sig = ""] = (await access.sign()).split(".");
    const forged = Buffer.from(JSON.stringify({ email: "someone@example.com" })).toString("base64url");
    expect(await verify(`${head}.${forged}.${sig}`, keys)).toBe(false);
  });

  it("証明は RS256 で、Access と同じクレームを持ち、テストが値を変えられる", async () => {
    const access = await createFakeAccess({ team: "dev", aud: "aud-dev", email: "owner@example.com", clock: fixedClock(NOW) });
    const { header, claims } = decode(await access.sign({ email: "someone@example.com" }));
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT", kid: access.kid() });
    expect(claims).toMatchObject({
      aud: ["aud-dev"],
      email: "someone@example.com",
      iss: "https://dev.cloudflareaccess.com",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
      type: "app",
    });
  });
});
