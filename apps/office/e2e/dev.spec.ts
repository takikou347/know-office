import { expect, test } from "@playwright/test";
import { addVirtualAuthenticator } from "./helpers/passkey.ts";

// 開発環境の代わりの物が、画面から使える形で立っている事を確かめる。ログインと記録の 3.9
test.describe("開発環境の代わりの物", () => {
  test("開発の時は代わりの Access、Claude API、GitHub が立っている", async ({ request }) => {
    const certs = await request.get("http://127.0.0.1:5199/access/cdn-cgi/access/certs");
    expect(await certs.json()).toMatchObject({ keys: [expect.objectContaining({ alg: "RS256" })] });
    const claude = await request.get("http://127.0.0.1:5199/anthropic/__fake/requests");
    expect(claude.ok()).toBe(true);
    const github = await request.get("http://127.0.0.1:5199/github/__fake/requests");
    expect(github.ok()).toBe(true);
  });

  test("仮想の認証器でパスキーを登録し、確認できる", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "仮想の認証器は Chrome の CDP にだけある");
    const authenticator = await addVirtualAuthenticator(page);
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const created = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: "localhost", name: "know-office" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "owner", displayName: "owner" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { userVerification: "required", residentKey: "required" },
        },
      });
      const got = await navigator.credentials.get({
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: "localhost", userVerification: "required" },
      });
      return [created?.type, got?.type];
    });
    expect(result).toEqual(["public-key", "public-key"]);
    expect(await authenticator.count()).toBe(1);
  });
});
