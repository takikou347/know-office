// e2e で使う Chrome の仮想の認証器。CDP の WebAuthn で、指紋や顔の確認を通った事にする。ログインと記録の 3.9
import type { Page } from "@playwright/test";

/** 認証器が持つパスキー 1 本。CDP の WebAuthn.Credential の形で、鍵と ID は base64 */
export type VirtualCredential = { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number };

/** 仮想の認証器 */
export type VirtualAuthenticator = {
  /** 認証器が持つパスキーの数 */
  count(): Promise<number>;
  /** 認証器が持つパスキー。秘密鍵も返る */
  credentials(): Promise<VirtualCredential[]>;
  /** 作ってあるパスキーを認証器に入れる */
  add(credential: VirtualCredential): Promise<void>;
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
    credentials: async () =>
      (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.map((c) => ({
        credentialId: c.credentialId,
        isResidentCredential: c.isResidentCredential,
        privateKey: c.privateKey,
        signCount: c.signCount,
        ...(c.rpId === undefined ? {} : { rpId: c.rpId }),
        ...(c.userHandle === undefined ? {} : { userHandle: c.userHandle }),
      })),
    add: async (credential) => {
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
    },
  };
}
