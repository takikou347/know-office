import { expect, test } from "./helpers/test.ts";
import { addVirtualAuthenticator } from "./helpers/passkey.ts";

// 設定の画面の、全体を止めた後の鍵の入れ直し。新しい鍵の作り方を 1 ページで案内し、パスキーで確かめてから入れ、古い鍵を消すように示す (自動停止の 3.5)
// ゲートウェイの返事は境目のモックで返し、画面が送る要求の中身を確かめる。ルートそのものは test/guard/rekey.test.ts で確かめる
const META = { traceId: "0".repeat(32) };
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(64)}\n-----END RSA PRIVATE KEY-----`;
const API_KEY = `sk-ant-api03-${"n".repeat(40)}`;
const SECRET = "whsec-new-0123456789abcdef";

test.describe("再開", () => {
  test("全体を止めた後の鍵の入れ直し", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "仮想の認証器は Chrome の CDP にだけある");
    await addVirtualAuthenticator(page);
    let pending = ["github_app", "claude"];
    const sent: { path: string; body: unknown }[] = [];
    const stepUps: unknown[] = [];
    let confirmed = false;
    await page.route("**/api/v1/guard/keys", (route) => route.fulfill({ json: { data: { held: pending.length > 0, pending }, meta: META } }));
    await page.route("**/api/v1/guard/keys/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      sent.push({ path, body: route.request().postDataJSON() });
      // 1 度目はパスキーの確認が切れている
      if (!confirmed) {
        await route.fulfill({ status: 401, contentType: "application/problem+json", json: { code: "step_up_required", traceId: META.traceId } });
        return;
      }
      pending = pending.filter((k) => k !== (path.endsWith("/claude") ? "claude" : "github_app"));
      await route.fulfill({ json: { data: { held: pending.length > 0, pending }, meta: META } });
    });
    await page.route("**/api/v1/passkeys/options", (route) =>
      route.fulfill({ json: { data: { challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZS0wMTIzNDU2Nzg5", rpId: "localhost", userVerification: "required", allowCredentials: [] }, meta: META } }),
    );
    await page.route("**/api/v1/me/step-up", async (route) => {
      stepUps.push(route.request().postDataJSON());
      confirmed = true;
      await route.fulfill({ json: { data: { stepUpUntil: new Date(Date.now() + 15 * 60_000).toISOString() }, meta: META } });
    });

    await page.goto("/settings");
    // 認証器にオーナーのパスキーを置く
    await page.evaluate(async () => {
      await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: "localhost", name: "know-office" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "owner", displayName: "owner" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { userVerification: "required", residentKey: "required" },
        },
      });
    });
    const main = page.getByRole("main");
    await expect(main.getByText("全体を止めたので、外の鍵を入れ直す")).toBeVisible();
    await expect(main.getByText("Generate a private key")).toBeVisible();

    await main.getByLabel("新しい秘密鍵 (PEM)").fill(PEM);
    await main.getByLabel("新しい Webhook secret").fill(SECRET);
    await main.getByRole("button", { name: "GitHub App の鍵を入れる" }).click();
    await expect(main.getByRole("button", { name: "GitHub App の鍵を入れる" })).toBeDisabled();
    // パスキーで確かめてから 1 度だけ送り直す
    expect(stepUps).toHaveLength(1);
    expect(stepUps[0]).toMatchObject({ type: "public-key", response: { authenticatorData: expect.any(String), signature: expect.any(String) } });

    await main.getByLabel("新しい API の鍵").fill(API_KEY);
    await main.getByRole("button", { name: "Claude の鍵を入れる" }).click();
    await expect(main.getByText("鍵を入れ直しました")).toBeVisible();
    await expect(main.getByText("古い秘密鍵を、Anthropic の Console で古い API の鍵を消してから", { exact: false })).toBeVisible();
    expect(sent).toEqual([
      { path: "/api/v1/guard/keys/github-app", body: { privateKey: PEM, webhookSecret: SECRET } },
      { path: "/api/v1/guard/keys/github-app", body: { privateKey: PEM, webhookSecret: SECRET } },
      { path: "/api/v1/guard/keys/claude", body: { apiKey: API_KEY } },
    ]);
  });

  test("全体を止めていなければ鍵の欄を出さない", async ({ page }) => {
    await page.route("**/api/v1/guard/keys", (route) => route.fulfill({ json: { data: { held: false, pending: [] }, meta: META } }));
    await page.goto("/settings");
    await expect(page.getByRole("main").getByRole("heading", { name: "拡張" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("heading", { name: "Claude の API の鍵" })).toHaveCount(0);
  });
});
