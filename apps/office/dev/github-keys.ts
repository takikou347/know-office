// 代わりの GitHub の App の秘密鍵の作り直しと、App の JWT の確かめ。オーナーが GitHub App の画面で秘密鍵を作り直し、前の秘密鍵を消すのと同じ事をする
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";
import type { FakeApp } from "./github-types.ts";

/** App の JWT の長さの上限 (10 分)。GitHub の決まり */
const APP_JWT_MAX_S = 600;

/**
 * App の JWT を確かめ、その App を返す関数を作る。GitHub と同じく RS256、iss は App ID、長さは 10 分まで
 * @param apps 作った App。ID から
 * @param now 今の時刻
 * @returns Authorization の値から App を返す関数。確かめられなければ null
 */
export function appVerifier(apps: ReadonlyMap<number, FakeApp>, now: () => number): (header: string | undefined) => Promise<FakeApp | null> {
  return async (header) => {
    const jwt = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    if (!jwt) return null;
    try {
      const app = apps.get(Number(decodeJwt(jwt).iss));
      if (!app) return null;
      const { payload } = await jwtVerify(jwt, app.publicKey, { algorithms: ["RS256"], issuer: String(app.id), currentDate: new Date(now()) });
      if (payload.iat === undefined || payload.exp === undefined || payload.exp - payload.iat > APP_JWT_MAX_S) return null;
      return app;
    } catch {
      return null;
    }
  };
}

/**
 * App の秘密鍵を作り直し、App の JWT を確かめる公開鍵を新しい物に替える
 * @param app 代わりの GitHub の App。無ければ投げる
 * @param app.publicKey 秘密鍵に対の公開鍵
 * @returns 新しい秘密鍵 (PKCS#1 の PEM)
 */
export function renewAppKey(app: { publicKey: KeyObject } | undefined): string {
  if (!app) throw new Error("App が無い");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  app.publicKey = publicKey;
  return privateKey.export({ type: "pkcs1", format: "pem" });
}
