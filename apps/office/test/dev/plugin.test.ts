// 開発用の vite のプラグインが、API への要求に代わりの Access の証明を付ける事を確かめる。ログインと記録の 3.9
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachAccess, localSessionCookie, PRODUCTION_CSP_HEADER, productionCsp, upgradeAccess } from "../../dev/plugin.ts";
import { cookieHeader, SESSION_COOKIE } from "../../src/gate/auth/session.ts";

/**
 * プラグインの手前の要求を作る
 * @param url パス
 * @param headers ヘッダー
 * @returns 要求
 */
function request(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  req.headers = headers;
  return req;
}

const sign = () => Promise.resolve("signed.jwt.token");

describe("開発環境の代わりの物", () => {
  it("API とワークスペースへの要求に、代わりの Access の証明を付ける", async () => {
    for (const url of ["/api/v1/health", "/ws/v1/events"]) {
      const req = request(url);
      await attachAccess(req, sign);
      expect(req.headers["cf-access-jwt-assertion"]).toBe("signed.jwt.token");
    }
  });

  it("画面のファイルへの要求には付けない", async () => {
    const req = request("/staff");
    await attachAccess(req, sign);
    expect(req.headers["cf-access-jwt-assertion"]).toBeUndefined();
  });

  it("ブラウザーが送った証明は、代わりの Access の物で置き換える", async () => {
    const req = request("/api/v1/health", { "cf-access-jwt-assertion": "forged" });
    await attachAccess(req, sign);
    expect(req.headers["cf-access-jwt-assertion"]).toBe("signed.jwt.token");
  });

  it("開発の入口では、ログインセッションのクッキーを Secure の無い名前でブラウザーに渡し、受けた時に元の名前へ戻す", () => {
    const req = request("/api/v1/sessions", { cookie: "theme=dark; ko_session=abc.def" });
    const res = new ServerResponse(req);
    localSessionCookie(req, res);
    // ゲートウェイには、本物と同じ __Host- の名前で届く
    expect(req.headers.cookie).toBe(`theme=dark; ${SESSION_COOKIE}=abc.def`);
    // setHeader と writeHead のどちらで返しても、ブラウザーには Secure の無い名前で渡る
    res.setHeader("Set-Cookie", [cookieHeader("abc.def", 60), "theme=dark; Path=/"]);
    expect(res.getHeader("Set-Cookie")).toEqual(["ko_session=abc.def; HttpOnly; SameSite=Strict; Path=/; Max-Age=60", "theme=dark; Path=/"]);
    res.writeHead(201, { "Set-Cookie": cookieHeader("ghi", 0) });
    expect(res.getHeader("Set-Cookie")).toBe("ko_session=ghi; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  });

  it("画面のファイルへの要求と、ほかのクッキーは変えない", () => {
    const req = request("/staff", { cookie: "ko_session=abc" });
    const res = new ServerResponse(req);
    localSessionCookie(req, res);
    expect(req.headers.cookie).toBe("ko_session=abc");
    res.setHeader("Set-Cookie", cookieHeader("abc", 60));
    expect(res.getHeader("Set-Cookie")).toBe(cookieHeader("abc", 60));
  });

  it("WebSocket への切り替えの要求にも、証明と元の名前のクッキーを付ける", () => {
    const req = request("/api/v1/live?ticket=t", { cookie: "theme=dark; ko_session=abc.def", "cf-access-jwt-assertion": "forged" });
    upgradeAccess(req, "signed.jwt.token");
    expect(req.headers["cf-access-jwt-assertion"]).toBe("signed.jwt.token");
    expect(req.headers.cookie).toBe(`theme=dark; ${SESSION_COOKIE}=abc.def`);
  });

  it("vite の HMR などほかの切り替えの要求は変えない", () => {
    const req = request("/?token=hmr", { cookie: "ko_session=abc" });
    upgradeAccess(req, "signed.jwt.token");
    expect(req.headers["cf-access-jwt-assertion"]).toBeUndefined();
    expect(req.headers.cookie).toBe("ko_session=abc");
  });

  it("頼まれた時だけ、文書の返事に本番の CSP を付ける。React の準備の script のほかは本番と同じに断る", () => {
    const headers = readFileSync(join(import.meta.dirname, "../../public/_headers"), "utf8");
    const asked = { [PRODUCTION_CSP_HEADER]: "1" };
    const page = request("/staff", { ...asked, "sec-fetch-dest": "document" });
    const res = new ServerResponse(page);
    productionCsp(page, res, headers);
    const csp = String(res.getHeader("Content-Security-Policy"));
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
    expect(csp).not.toContain("unsafe-eval");
    // 頼まない要求と、文書でない要求には付けない
    for (const req of [request("/staff", { "sec-fetch-dest": "document" }), request("/src/main.tsx", { ...asked, "sec-fetch-dest": "script" })]) {
      const other = new ServerResponse(req);
      productionCsp(req, other, headers);
      expect(other.getHeader("Content-Security-Policy")).toBeUndefined();
    }
  });
});
