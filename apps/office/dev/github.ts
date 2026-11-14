// 開発環境の代わりの GitHub。テストが置いた返事を返し、署名付きの通知を送る
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";

const FakeRoute = z.object({ route: z.string(), body: z.unknown() });

/** 届いた要求 */
export type GitHubRequest = {
  /** 「メソッド パス」 */
  route: string;
  /** 本文。無ければ null */
  body: unknown;
};

/** 代わりの GitHub */
export type FakeGitHub = {
  /** GitHub の REST API の形の Hono */
  app: Hono;
  /** 届いた要求 */
  requests: GitHubRequest[];
  /** 「メソッド パス」に返す本文を置く */
  set(route: string, body: unknown): void;
};

/**
 * 代わりの GitHub を作る
 * @returns Hono、届いた要求、返事を置く set
 */
export function createFakeGitHub(): FakeGitHub {
  const routes = new Map<string, unknown>();
  const requests: GitHubRequest[] = [];
  let tokens = 0;

  const app = new Hono()
    .post("/__fake/routes", async (c) => {
      const { route, body } = FakeRoute.parse(await c.req.json());
      routes.set(route, body);
      return c.body(null, 204);
    })
    .get("/__fake/requests", (c) => c.json(requests))
    .all("*", async (c) => {
      if (!c.req.header("authorization")) return c.json({ message: "Requires authentication" }, 401);
      const route = `${c.req.method} ${c.req.path}`;
      const text = await c.req.text();
      requests.push({ route, body: text ? z.unknown().parse(JSON.parse(text)) : null });
      if (/^POST \/app\/installations\/\d+\/access_tokens$/.test(route)) {
        tokens += 1;
        return c.json({ token: `ghs_fake${String(tokens)}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      if (!routes.has(route)) return c.json({ message: "Not Found" }, 404);
      return c.json(routes.get(route));
    });

  return { app, requests, set: (route, body) => routes.set(route, body) };
}

/** 代わりの GitHub が送る通知 */
export type WebhookOptions = {
  /** 送り先 */
  url: string;
  /** X-GitHub-Event の値 */
  event: string;
  /** 本文 */
  payload: unknown;
  /** 署名の鍵 */
  secret: string;
  /** 送る関数。初期値は fetch */
  fetcher?: (req: Request) => Promise<Response>;
};

/**
 * GitHub と同じヘッダーと署名で通知を送る
 * @param options 送り先、種類、本文、署名の鍵
 * @returns 送り先の返事
 */
export function sendWebhook(options: WebhookOptions): Promise<Response> {
  const body = JSON.stringify(options.payload);
  const signature = `sha256=${createHmac("sha256", options.secret).update(body).digest("hex")}`;
  const req = new Request(options.url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event,
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": signature,
    },
  });
  return (options.fetcher ?? fetch)(req);
}
