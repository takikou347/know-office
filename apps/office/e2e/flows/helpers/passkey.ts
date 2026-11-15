// 利用場面の通しで使うオーナーのパスキー。passkey.setup.ts が設定の画面で登録した 1 本を、各テストの仮想の認証器に入れる
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { addVirtualAuthenticator, type VirtualAuthenticator, type VirtualCredential } from "../../helpers/passkey.ts";

// 鍵は、登録した先の手元の D1 と同じ所に置く。test-results は通しを流すたびに空になる
const STORE = join(import.meta.dirname, "../../../.wrangler/e2e-passkey.json");
const Stored = z.object({ credentialId: z.string(), isResidentCredential: z.boolean(), rpId: z.string().optional(), privateKey: z.string(), userHandle: z.string().optional(), signCount: z.number() });

// 署名の回数の起点。ゲートウェイは前より大きい回数だけを受けるので、入れるたびに今の時刻から作る
const COUNT_EPOCH = Date.UTC(2026, 0, 1);

/**
 * 登録したパスキーを、ほかのテストが使えるように置く
 * @param credential 認証器から読んだパスキー
 */
export function storePasskey(credential: VirtualCredential): void {
  writeFileSync(STORE, JSON.stringify(Stored.parse(credential)));
}

/**
 * ページに仮想の認証器を付け、登録済みのオーナーのパスキーを入れる。このページでパスキーの確認を求められると、認証器が自動で確かめる
 * @param page 付けるページ
 * @returns 仮想の認証器
 */
export async function useOwnerPasskey(page: Page): Promise<VirtualAuthenticator> {
  const authenticator = await addVirtualAuthenticator(page);
  const stored = Stored.parse(JSON.parse(readFileSync(STORE, "utf8")));
  // 認証器は入れた回数から数え直すので、前のテストより必ず大きくなるよう 0.1 秒ごとに 1 進む数にする
  const signCount = Math.floor((Date.now() - COUNT_EPOCH) / 100);
  await authenticator.add({
    credentialId: stored.credentialId,
    isResidentCredential: stored.isResidentCredential,
    privateKey: stored.privateKey,
    signCount,
    ...(stored.rpId === undefined ? {} : { rpId: stored.rpId }),
    ...(stored.userHandle === undefined ? {} : { userHandle: stored.userHandle }),
  });
  return authenticator;
}
