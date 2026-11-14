// Vitest で使うソフトウェアの認証器。P-256 の鍵で WebAuthn の登録と確認の返事を作る。ログインと記録の 3.9
import { createHash } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type Cbor = number | string | Uint8Array | Map<number | string, Cbor> | { [key: string]: Cbor };

/**
 * CBOR の頭 (種類と長さ) を作る
 * @param major 種類
 * @param length 長さか値
 * @returns 頭のバイト列
 */
function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  return [(major << 5) | 25, length >> 8, length & 0xff];
}

/**
 * WebAuthn に要る分だけの CBOR を書く
 * @param value 整数、文字列、バイト列、対応
 * @returns CBOR のバイト列
 */
function cbor(value: Cbor): number[] {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = [...new TextEncoder().encode(value)];
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])];
}

/**
 * DER の INTEGER を書く。頭の 0 を削り、負に読まれる時は 0 を足す
 * @param bytes 符号の無い整数
 * @returns DER の INTEGER
 */
function derInteger(bytes: Uint8Array): number[] {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
  const trimmed = Array.from(bytes.subarray(i));
  const padded = (trimmed[0] ?? 0) & 0x80 ? [0, ...trimmed] : trimmed;
  return [0x02, padded.length, ...padded];
}

/**
 * WebCrypto の r||s の署名を、WebAuthn が求める DER に直す
 * @param raw 64 バイトの署名
 * @returns DER の署名
 */
function toDer(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.slice(0, 32)), ...derInteger(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/**
 * clientDataJSON を作る
 * @param type webauthn.create か webauthn.get
 * @param challenge 受けた challenge
 * @param origin 画面の origin
 * @returns clientDataJSON のバイト列
 */
function clientData(type: string, challenge: string, origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** 登録のオプションのうち、認証器が読む所。PublicKeyCredentialCreationOptionsJSON はこの形を満たす */
export type RegistrationOptions = Pick<PublicKeyCredentialCreationOptionsJSON, "challenge"> & { rp: { id?: string }; user: { id: string } };

/** 確認のオプションのうち、認証器が読む所。PublicKeyCredentialRequestOptionsJSON はこの形を満たす */
export type AuthenticationOptions = Pick<PublicKeyCredentialRequestOptionsJSON, "challenge" | "rpId">;

/** ソフトウェアの認証器 */
export type Authenticator = {
  /** 登録の返事を作る */
  register(options: RegistrationOptions, origin: string): Promise<RegistrationResponseJSON>;
  /** 確認の返事を作る。作るたびに数を 1 つ進める */
  authenticate(options: AuthenticationOptions, origin: string): Promise<AuthenticationResponseJSON>;
};

/**
 * 鍵を 1 つ持つソフトウェアの認証器を作る
 * @returns 登録と確認の返事を作る認証器
 */
export async function createAuthenticator(): Promise<Authenticator> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = b64(credentialId);
  let counter = 0;
  let userHandle = "";

  const authData = (rpId: string, flags: number, attested: number[] = []) =>
    new Uint8Array([...sha256(rpId), flags, (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff, ...attested]);

  return {
    register: (options, origin) => {
      userHandle = options.user.id;
      const rpId = options.rp.id ?? new URL(origin).hostname;
      const cose = new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y ?? "", "base64url"))],
      ]);
      const attested = [...new Uint8Array(16), 0, credentialId.length, ...credentialId, ...cbor(cose)];
      // UP、UV、AT の旗
      const data = authData(rpId, 0x01 | 0x04 | 0x40, attested);
      const attestation = new Uint8Array(cbor({ fmt: "none", attStmt: {}, authData: data }));
      return Promise.resolve({
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: b64(attestation),
          transports: ["internal"],
        },
      });
    },
    authenticate: async (options, origin) => {
      counter += 1;
      const rpId = options.rpId ?? new URL(origin).hostname;
      const data = authData(rpId, 0x01 | 0x04);
      const client = clientData("webauthn.get", options.challenge, origin);
      const signed = new Uint8Array([...data, ...sha256(client)]);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(toDer(raw)), userHandle },
      };
    },
  };
}
