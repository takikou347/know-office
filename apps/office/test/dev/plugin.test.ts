// 開発用の vite のプラグインが、API への要求に代わりの Access の証明を付ける事を確かめる。ログインと記録の 3.9
import { createServer, get, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { attachAccess, edgeGzip, localSessionCookie, upgradeAccess } from "../../dev/plugin.ts";
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
});

const TEXT = "const screen = 'ダッシュボード';\n".repeat(200);

/**
 * edgeGzip を通して、cloudflare のプラグインと同じ形 (writeHead に状態と文と見出し、write、end) で返すサーバーに 1 度要求する
 * @param type 返す Content-Type
 * @param acceptEncoding ブラウザーが送る Accept-Encoding。無ければ送らない
 * @param body 返す中身
 * @returns 届いた見出しと、送られたままの中身
 */
async function fetchThrough(type: string, acceptEncoding?: string, body = Buffer.from(TEXT)): Promise<{ headers: IncomingMessage["headers"]; raw: Buffer }> {
  const server = createServer((req, res) => {
    edgeGzip(req, res);
    res.writeHead(200, "OK", { "content-type": type, "content-length": String(body.length) });
    // cloudflare のプラグインと同じく 16 KB ずつ書き、詰まったら drain を待つ
    void (async () => {
      for (let at = 0; at < body.length; at += 16_384) {
        if (!res.write(body.subarray(at, at + 16_384))) await new Promise((resolve) => res.once("drain", resolve));
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("待ち受けの番号が無い");
    const { port } = address;
    return await new Promise((resolve, reject) => {
      get({ port, host: "127.0.0.1", path: "/assets/index.js", headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ headers: res.headers, raw: Buffer.concat(chunks) }));
      }).on("error", reject);
    });
  } finally {
    server.close();
  }
}

describe("build した画面のプレビュー", () => {
  it("文字のファイルは、本物の入口と同じく gzip で縮めて返す", async () => {
    const { headers, raw } = await fetchThrough("text/javascript; charset=utf-8", "gzip, deflate, br");
    expect(headers["content-encoding"]).toBe("gzip");
    expect(headers["content-length"]).toBeUndefined();
    expect(headers.vary).toContain("Accept-Encoding");
    const text = gunzipSync(raw).toString("utf8");
    expect(text).toBe(TEXT);
    expect(raw.length).toBeLessThan(text.length);
  });

  it("画面の JS ほどの大きなファイルも、gzip の詰まりで止まらずに最後まで返す", async () => {
    const body = Buffer.from(Array.from({ length: 60_000 }, (_, i) => `const v${String(i)} = ${String((i * 7919) % 10_007)};\n`).join(""));
    const { raw } = await fetchThrough("text/javascript", "gzip", body);
    expect(gunzipSync(raw).equals(body)).toBe(true);
  });

  it("gzip を受けないブラウザーと、縮まない画像やフォントはそのまま返す", async () => {
    for (const [type, accept] of [
      ["text/javascript", undefined],
      ["font/woff2", "gzip"],
    ] as const) {
      const { headers, raw } = await fetchThrough(type, accept);
      expect(headers["content-encoding"]).toBeUndefined();
      expect(raw.toString("utf8")).toBe(TEXT);
    }
  });
});
