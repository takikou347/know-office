// 開発の時だけ使う。代わりの GitHub の、画面の通しから呼ぶ口。オーナーが GitHub の画面で秘密鍵を作り直す事と、GitHub の失敗を置いて返す事
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { sendWebhook } from "./github-hooks.ts";
import { renewAppKey } from "./github-keys.ts";
import type { FakePulls } from "./github-pulls.ts";
import type { FakeApp } from "./github-types.ts";

/** 代わりの GitHub に通知を送らせる要求。種類と本文。installation は代わりの GitHub が付ける */
const FakeHook = z.object({ event: z.string().min(1), payload: z.record(z.string(), z.unknown()) });

/** 置く失敗の道、返すステータス、返す回数、足すヘッダー (レート制限の retry-after や x-ratelimit-remaining) */
const FakeFailure = z.object({
  route: z.string(),
  status: z.number().int().min(400).max(599),
  times: z.number().int().min(1).max(10).default(1),
  headers: z.record(z.string(), z.string()).optional(),
});

/** ブランチの先を進める要求。画面の通しが、開発担当の push の代わりに送る */
const FakePush = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string().min(1) }).strict();

/** 先を進めて通知を送るのに使う、代わりの GitHub の中身 */
export type PushDeps = {
  /** インストール。ID から、App ID と選んだリポジトリ */
  installations: Map<number, { appId: number; repos: string[] }>;
  /** プルリクエストの代わり */
  pulls: FakePulls;
  /** 通知を送るゲートウェイの宛先を返す。無ければ通知を送らない */
  hookUrl: (() => string) | undefined;
};

/** 道ごとの、置いた失敗と残りの回数 */
export type FakeFailures = Map<string, { status: number; left: number; headers?: Record<string, string> }>;

/**
 * 置いた失敗を 1 度返す関数を作る。画面の通しは、開発の画面が読み込みを 2 度走らせるので 2 度置ける
 * @param failures 道ごとの、置いた失敗と残りの回数
 * @returns 道を受け、置いた失敗があればその返事、無ければ null を返す関数
 */
export function failureTaker(failures: FakeFailures): (route: string) => Response | null {
  return (route) => {
    const failure = failures.get(route);
    if (failure === undefined) return null;
    if (failure.left > 1) failures.set(route, { ...failure, left: failure.left - 1 });
    else failures.delete(route);
    return new Response(JSON.stringify({ message: "fake failure" }), { status: failure.status, headers: { ...failure.headers, "content-type": "application/json" } });
  };
}

/**
 * 画面の通しから呼ぶ口を作る
 * @param apps 作った App
 * @param failures 道ごとの、置いた失敗と残りの回数
 * @param push 先を進めて通知を送るのに使う中身
 * @returns 口
 */
export function flowRoutes(apps: Map<number, FakeApp>, failures: FakeFailures, push: PushDeps): Hono {
  return (
    new Hono()
      // 置いた回数だけ、その道に失敗を返す
      .post("/__fake/failures", async (c) => {
        const { route, status, times, headers } = FakeFailure.parse(await c.req.json());
        failures.set(route, { status, left: times, ...(headers ? { headers } : {}) });
        return c.body(null, 204);
      })
      // 開発担当が push したのと同じく、ブランチの先を進め、そのブランチの開いたプルリクエストの synchronize の通知をゲートウェイに送る
      .post("/__fake/pushes", async (c) => {
        const { repo, branch } = FakePush.parse(await c.req.json());
        // 前の通しがつないだ App の入れ先も残るので、そのリポジトリに入れた最後の入れ先 (今つないでいる物) の鍵で送る
        const [installationId = 0, inst] = [...push.installations.entries()].findLast(([, i]) => i.repos.includes(repo)) ?? [];
        const secret = inst ? apps.get(inst.appId)?.webhookSecret : undefined;
        const url = push.hookUrl?.();
        return c.json(await push.pulls.pushed(repo, branch, url === undefined || secret === undefined ? null : { url, secret, installationId }));
      })
      // 置いた失敗を全部外す。画面の通しの片付けに使う
      .delete("/__fake/failures", (c) => {
        failures.clear();
        return c.body(null, 204);
      })
      // GitHub が App の通知の宛先 (manifest の hook_attributes.url) へ、App の通知の秘密で署名して送る通知を、通しが起こす
      .post("/__fake/hooks", async (c) => {
        const input = FakeHook.parse(await c.req.json());
        const made = [...apps.values()].at(-1);
        const installed = [...push.installations.entries()].find(([, v]) => v.appId === made?.id)?.[0];
        if (!made || installed === undefined) return c.json({ message: "App がインストールされていない" }, 409);
        const res = await sendWebhook({ url: made.manifest.hook_attributes.url, event: input.event, payload: { ...input.payload, installation: { id: installed } }, secret: made.webhookSecret });
        return c.body(null, res.status === 204 ? 204 : 502);
      })
      // 画面: オーナーが App の設定で「Generate a private key」を押すと、新しい秘密鍵の PEM が落ちてくる
      .post("/web/settings/apps/:slug/keys", (c) => {
        const found = [...apps.values()].find((a) => a.slug === c.req.param("slug"));
        if (!found) return c.text("Not Found", 404);
        return c.text(renewAppKey(found), 200, { "content-type": "application/x-pem-file" });
      })
  );
}

/**
 * GitHub と同じく、User-Agent の無い API と git の要求を 403 で断る。テストの置き場 (/__fake) と人が開く画面 (/web) には当てない
 * @param c 要求の文脈
 * @param next 次の受け手
 * @returns 断る時は 403 の返事
 */
export const requireUserAgent: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const exempt = path.startsWith("/__fake/") || path.startsWith("/web/");
  if (exempt || c.req.header("user-agent")) return next();
  return c.json({ message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header" }, 403);
};

/**
 * 代わりの GitHub を別の道の下 (/github) に立てた時の、その頭を返す。立てる道は呼ばれた時の routePath の末尾の /* の手前
 * @param routePath 当たった道の形
 * @returns 頭。直に立てていれば空
 */
export function mountedAt(routePath: string): string {
  return routePath.endsWith("/*") ? routePath.slice(0, -2) : "";
}

/** compare が返すファイルの上限。GitHub は比べる全体で 300 件までしか返さない (GitHub の REST API の Compare two commits) */
const COMPARE_FILES = 300;

const PlacedCompare = z.object({ files: z.array(z.unknown()) }).loose();

/**
 * 置いた compare の返事を、GitHub と同じく 300 ファイルで切る。compare でない返事はそのまま返す
 * @param route 「メソッド 道」 (/github の頭を除いた物)
 * @param body 置いた返事
 * @returns 返す本文
 */
export function capCompare(route: string, body: unknown): unknown {
  if (!/^GET \/repos\/[^/]+\/[^/]+\/compare\//.test(route)) return body;
  const placed = PlacedCompare.safeParse(body);
  return placed.success ? { ...placed.data, files: placed.data.files.slice(0, COMPARE_FILES) } : body;
}
