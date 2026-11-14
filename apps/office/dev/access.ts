// 開発環境の代わりの Cloudflare Access。テスト用の鍵で証明を出し、公開鍵を Access と同じ形で返す
import type { Clock } from "@know-office/core";
import { Hono } from "hono";
import { base64url, base64urlText } from "./encoding.ts";

/** 代わりの Access の設定 */
export type FakeAccessOptions = {
  /** Access のチーム名。iss に入る */
  team: string;
  /** アプリの宛先 (aud) */
  aud: string;
  /** ログインした人のメールアドレス */
  email: string;
  /** 時刻 */
  clock: Clock;
};

/** 代わりの Access */
export type FakeAccess = {
  /** `/cdn-cgi/access/certs` を返す Hono */
  app: Hono;
  /** 鍵の ID */
  kid: string;
  /** 証明を出す。テストはクレームを変えられる */
  sign: (overrides?: Record<string, unknown>) => Promise<string>;
};

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

/**
 * 起動ごとに鍵を作り、代わりの Access を作る
 * @param options チーム名、宛先、メールアドレス、時刻
 * @returns 公開鍵を返す Hono と、証明を出す sign
 */
export async function createFakeAccess(options: FakeAccessOptions): Promise<FakeAccess> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const kid = crypto.randomUUID();
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, kid, alg: "RS256", use: "sig" };

  const app = new Hono().get("/cdn-cgi/access/certs", (c) => c.json({ keys: [jwk], public_cert: { kid }, public_certs: [{ kid }] }));

  const sign = async (overrides: Record<string, unknown> = {}) => {
    const iat = Math.floor(options.clock.now() / 1000);
    const claims = {
      aud: [options.aud],
      email: options.email,
      exp: iat + 3600,
      iat,
      nbf: iat,
      iss: `https://${options.team}.cloudflareaccess.com`,
      sub: "00000000-0000-4000-8000-000000000001",
      type: "app",
      identity_nonce: "dev",
      country: "JP",
      ...overrides,
    };
    const input = `${base64urlText(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }))}.${base64urlText(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign(ALGORITHM.name, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${base64url(signature)}`;
  };

  return { app, kid, sign };
}
