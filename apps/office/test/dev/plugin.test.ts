// 開発用の vite のプラグインが、API への要求に代わりの Access の証明を付ける事を確かめる。ログインと記録の 3.9
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { attachAccess } from "../../dev/plugin.ts";

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
});
