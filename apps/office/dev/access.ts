// 開発環境の代わりの Cloudflare Access。テスト用の鍵で証明を出し、公開鍵を Access と同じ形で返す
import { type Clock, toBase64url } from "@know-office/core";
import { Hono } from "hono";

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
  /** 今の鍵の ID */
  kid(): string;
  /** 証明を出す。テストはクレームを変えられる */
  sign: (overrides?: Record<string, unknown>) => Promise<string>;
  /** 鍵を取り替える。Access が鍵を回した時を、テストで起こす */
  rotate(): Promise<void>;
};

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;

/**
 * 起動ごとに鍵を作り、代わりの Access を作る
 * @param options チーム名、宛先、メールアドレス、時刻
 * @returns 公開鍵を返す Hono と、証明を出す sign
 */
export async function createFakeAccess(options: FakeAccessOptions): Promise<FakeAccess> {
  let current = await newKey();

  const app = new Hono().get("/cdn-cgi/access/certs", (c) =>
    c.json({ keys: [current.jwk], public_cert: { kid: current.jwk.kid }, public_certs: [{ kid: current.jwk.kid }] }),
  );

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
    const input = `${jsonPart({ alg: "RS256", kid: current.jwk.kid, typ: "JWT" })}.${jsonPart(claims)}`;
    const signature = await crypto.subtle.sign(ALGORITHM.name, current.privateKey, new TextEncoder().encode(input));
    return `${input}.${toBase64url(signature)}`;
  };

  return {
    app,
    kid: () => current.jwk.kid,
    sign,
    rotate: async () => {
      current = await newKey();
    },
  };
}

/**
 * JWT のヘッダーとクレームを base64url の JSON にする
 * @param value ヘッダーかクレーム
 * @returns JWT の 1 つの部分
 */
function jsonPart(value: unknown): string {
  return toBase64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * 証明に使う RSA の鍵の組と、公開鍵の JWK を作る
 * @returns 秘密鍵と、kid を付けた公開鍵の JWK
 */
async function newKey(): Promise<{ privateKey: CryptoKey; jwk: { kty?: string; n?: string; e?: string; kid: string; alg: string; use: string } }> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, kid: crypto.randomUUID(), alg: "RS256", use: "sig" } };
}
