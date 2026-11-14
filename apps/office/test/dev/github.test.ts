// 開発環境の代わりの GitHub を確かめる。ログインと記録の 3.9
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeGitHub, sendWebhook } from "../../dev/github.ts";

describe("開発環境の代わりの物", () => {
  it("代わりの GitHub はインストールのトークンを返す", async () => {
    const github = createFakeGitHub();
    const res = await github.app.request("/app/installations/1/access_tokens", { method: "POST", headers: { authorization: "Bearer app-jwt" } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ token: expect.stringMatching(/^ghs_/) as unknown, expires_at: expect.any(String) as unknown });
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
    expect(req?.headers.get("x-github-delivery")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
