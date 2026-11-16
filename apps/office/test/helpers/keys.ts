// テストの代わりの Access と GitHub に渡す RSA の鍵。1 つ作るのに 50 ms ほどかかるので、作った鍵をテストをまたいで使い回し、1 つのテストの中では毎回別の鍵を渡す
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { generateAccessKeyPair } from "../../dev/access.ts";

/** 作った鍵と、今のテストで渡した数 */
const access = { made: [] as Promise<CryptoKeyPair>[], used: 0 };
const github = { made: [] as { privateKey: KeyObject; publicKey: KeyObject }[], used: 0 };

/**
 * 頭の鍵から渡し直す。test/setup.ts がテストごとに呼ぶ
 */
export function resetKeys(): void {
  access.used = 0;
  github.used = 0;
}

/**
 * 代わりの Access の証明の鍵の組を渡す
 * @returns 今のテストでまだ渡していない鍵の組
 */
export function accessKeyPair(): Promise<CryptoKeyPair> {
  const i = access.used++;
  access.made[i] ??= generateAccessKeyPair();
  return access.made[i];
}

/**
 * 代わりの GitHub の App の鍵の組を渡す
 * @returns 今のテストでまだ渡していない鍵の組
 */
export function githubAppKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  const i = github.used++;
  github.made[i] ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return github.made[i];
}
