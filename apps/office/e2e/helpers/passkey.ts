// e2e で使う Chrome の仮想の認証器。CDP の WebAuthn で、指紋や顔の確認を通った事にする。ログインと記録の 3.9
import type { Page } from "@playwright/test";

/** 仮想の認証器 */
export type VirtualAuthenticator = {
  /** 認証器が持つパスキーの数 */
  count(): Promise<number>;
};

/**
 * ページに仮想の認証器を付ける。Chrome だけで動く
 * @param page 付けるページ
 * @returns 仮想の認証器
 */
export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return {
    count: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
  };
}
