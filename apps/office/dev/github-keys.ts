// 代わりの GitHub の App の秘密鍵の作り直し。オーナーが GitHub App の画面で秘密鍵を作り直し、前の秘密鍵を消すのと同じ事をする
import { generateKeyPairSync, type KeyObject } from "node:crypto";

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
