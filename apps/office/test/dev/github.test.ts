// 開発環境の代わりの GitHub を確かめる。ログインと記録の 3.9
import { createHmac, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeGitHub } from "../../dev/github.ts";
import { deliveryId, sendWebhook } from "../../dev/github-hooks.ts";

/**
 * git の Basic の合言葉に鍵を入れたヘッダー
 * @param t 鍵
 * @returns ヘッダー
 */
const basic = (t: string) => ({ authorization: `Basic ${btoa(`x-access-token:${t}`)}` });

describe("開発環境の代わりの物", () => {
  it("代わりの GitHub は App を作り、入れ、App の JWT でリポジトリを絞った鍵を返す", async () => {
    const github = createFakeGitHub();
    const manifest = { name: "ko", url: "http://localhost", redirect_url: "http://localhost/cb", setup_url: "http://localhost/installed", hook_attributes: { url: "http://localhost/hooks" }, public: false, default_permissions: { contents: "write", metadata: "read" }, default_events: [] };
    const made = await github.app.request("/web/settings/apps/new?state=s1", { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(manifest) }) });
    const back = new URL(made.headers.get("location") ?? "");
    expect(back.searchParams.get("state")).toBe("s1");
    const conversion = z.object({ id: z.number(), slug: z.string(), pem: z.string() }).loose().parse(await (await github.app.request(`/app-manifests/${back.searchParams.get("code") ?? ""}/conversions`, { method: "POST" })).json());
    expect(conversion.pem).toContain("BEGIN RSA PRIVATE KEY");
    const installed = new URL((await github.app.request(`/web/apps/${conversion.slug}/installations/new`)).headers.get("location") ?? "");
    const installation = installed.searchParams.get("installation_id") ?? "";
    const key = createPrivateKey(conversion.pem);
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(String(conversion.id)).setIssuedAt().setExpirationTime("9m").sign(key);
    const minted = await github.app.request(`/app/installations/${installation}/access_tokens`, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: JSON.stringify({ repositories: ["knowidea-ui"], permissions: { contents: "write" } }) });
    expect(minted.status).toBe(201);
    const token = z.object({ token: z.string() }).loose().parse(await minted.json()).token;
    expect((await github.app.request("/git/example/knowidea-ui.git/git-receive-pack", { method: "POST", headers: basic(token) })).status).toBe(200);
    expect((await github.app.request("/git/example/know-office.git/git-receive-pack", { method: "POST", headers: basic(token) })).status).toBe(403);
    const other = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(String(conversion.id)).setIssuedAt().setExpirationTime("9m").sign(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
    expect((await github.app.request(`/app/installations/${installation}/access_tokens`, { method: "POST", headers: { authorization: `Bearer ${other}` } })).status).toBe(401);
  });

  it("代わりの GitHub は App の秘密鍵を作り直すと、前の秘密鍵の JWT を断る", async () => {
    const github = createFakeGitHub();
    const manifest = { name: "ko", url: "http://localhost", redirect_url: "http://localhost/cb", setup_url: "http://localhost/installed", hook_attributes: { url: "http://localhost/hooks" }, public: false, default_permissions: { contents: "write" }, default_events: [] };
    const made = await github.app.request("/web/settings/apps/new?state=s1", { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(manifest) }) });
    const code = new URL(made.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const conversion = z.object({ id: z.number(), slug: z.string(), pem: z.string() }).loose().parse(await (await github.app.request(`/app-manifests/${code}/conversions`, { method: "POST" })).json());
    const installed = new URL((await github.app.request(`/web/apps/${conversion.slug}/installations/new`)).headers.get("location") ?? "");
    const path = `/app/installations/${installed.searchParams.get("installation_id") ?? ""}`;
    const jwtOf = (pem: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(String(conversion.id)).setIssuedAt().setExpirationTime("9m").sign(createPrivateKey(pem));
    const fresh = github.newPrivateKey(conversion.id);
    expect(fresh).toContain("BEGIN RSA PRIVATE KEY");
    expect((await github.app.request(path, { headers: { authorization: `Bearer ${await jwtOf(conversion.pem)}` } })).status).toBe(401);
    expect((await github.app.request(path, { headers: { authorization: `Bearer ${await jwtOf(fresh)}` } })).status).toBe(200);
  });

  it("代わりの GitHub は画面の通しから、秘密鍵の作り直しと、次の 1 度だけの失敗を受ける", async () => {
    const github = createFakeGitHub();
    const manifest = { name: "ko", url: "http://localhost", redirect_url: "http://localhost/cb", setup_url: "http://localhost/installed", hook_attributes: { url: "http://localhost/hooks" }, public: false, default_permissions: { contents: "write" }, default_events: [] };
    const made = await github.app.request("/web/settings/apps/new?state=s1", { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(manifest) }) });
    const code = new URL(made.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const conversion = z.object({ id: z.number(), slug: z.string() }).loose().parse(await (await github.app.request(`/app-manifests/${code}/conversions`, { method: "POST" })).json());
    const key = await github.app.request(`/web/settings/apps/${conversion.slug}/keys`, { method: "POST" });
    expect(key.status).toBe(200);
    expect(await key.text()).toContain("BEGIN RSA PRIVATE KEY");
    expect((await github.app.request("/web/settings/apps/no-such/keys", { method: "POST" })).status).toBe(404);

    const failed = await github.app.request("/__fake/failures", { method: "POST", body: JSON.stringify({ route: "GET /installation/repositories", status: 502 }) });
    expect(failed.status).toBe(204);
    expect((await github.app.request("/installation/repositories", { headers: { authorization: "Bearer ghs_x" } })).status).toBe(502);
    // 失敗は 1 度だけで、次は鍵を確かめる
    expect((await github.app.request("/installation/repositories", { headers: { authorization: "Bearer ghs_x" } })).status).toBe(401);
  });

  it("代わりの GitHub は積んだ返事を返し、無い物は 404 で返す", async () => {
    const github = createFakeGitHub();
    github.set("GET /repos/o/r/pulls", [{ number: 1, title: "PR" }]);
    const ok = await github.app.request("/repos/o/r/pulls", { headers: { authorization: "token ghs_x" } });
    expect(await ok.json()).toEqual([{ number: 1, title: "PR" }]);
    const missing = await github.app.request("/repos/o/r/issues", { headers: { authorization: "token ghs_x" } });
    expect(missing.status).toBe(404);
    expect(github.requests.map((r) => r.route)).toEqual(["GET /repos/o/r/pulls", "GET /repos/o/r/issues"]);
  });

  it("代わりの GitHub は鍵が無ければ 401 を返す", async () => {
    const res = await createFakeGitHub().app.request("/repos/o/r/pulls");
    expect(res.status).toBe(401);
  });

  it("代わりの GitHub の通知は X-Hub-Signature-256 で署名される", async () => {
    const seen: Request[] = [];
    const fetcher = (req: Request) => {
      seen.push(req);
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await sendWebhook({ url: "http://localhost/hooks/v1/github", event: "pull_request", payload: { action: "opened" }, secret: "s3cret", fetcher });
    const req = seen[0];
    const body = (await req?.text()) ?? "";
    expect(req?.headers.get("x-github-event")).toBe("pull_request");
    expect(req?.headers.get("x-hub-signature-256")).toBe(`sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`);
    // GitHub の配信 ID は時刻の入った UUID (版 1)
    expect(req?.headers.get("x-github-delivery")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("代わりの GitHub の配信 ID は時刻を 100 ナノ秒の数で持つ", () => {
    const [low = "", mid = "", high = ""] = deliveryId(Date.UTC(2026, 11, 1)).split("-");
    const ticks = (BigInt(`0x${high.slice(1)}`) << 48n) | (BigInt(`0x${mid}`) << 32n) | BigInt(`0x${low}`);
    expect(Number((ticks - 0x01b21dd213814000n) / 10_000n)).toBe(Date.UTC(2026, 11, 1));
  });
});
