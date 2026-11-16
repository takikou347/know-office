// 開発の時だけ使う。代わりの GitHub の、画面の通しから呼ぶ口。オーナーが GitHub の画面で秘密鍵を作り直す事と、GitHub の失敗を置いて返す事
import { Hono } from "hono";
import { z } from "zod";
import { renewAppKey } from "./github-keys.ts";
import type { FakeApp } from "./github-types.ts";

/** 置く失敗の道、返すステータス、返す回数 */
const FakeFailure = z.object({ route: z.string(), status: z.number().int().min(400).max(599), times: z.number().int().min(1).max(10).default(1) });

/** 道ごとの、置いた失敗と残りの回数 */
export type FakeFailures = Map<string, { status: number; left: number }>;

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
    return new Response(JSON.stringify({ message: "fake failure" }), { status: failure.status, headers: { "content-type": "application/json" } });
  };
}

/**
 * 画面の通しから呼ぶ口を作る
 * @param apps 作った App
 * @param failures 道ごとの、置いた失敗と残りの回数
 * @returns 口
 */
export function flowRoutes(apps: Map<number, FakeApp>, failures: FakeFailures): Hono {
  return (
    new Hono()
      // 置いた回数だけ、その道に失敗を返す
      .post("/__fake/failures", async (c) => {
        const { route, status, times } = FakeFailure.parse(await c.req.json());
        failures.set(route, { status, left: times });
        return c.body(null, 204);
      })
      // 置いた失敗を全部外す。画面の通しの片付けに使う
      .delete("/__fake/failures", (c) => {
        failures.clear();
        return c.body(null, 204);
      })
      // 画面: オーナーが App の設定で「Generate a private key」を押すと、新しい秘密鍵の PEM が落ちてくる
      .post("/web/settings/apps/:slug/keys", (c) => {
        const found = [...apps.values()].find((a) => a.slug === c.req.param("slug"));
        if (!found) return c.text("Not Found", 404);
        return c.text(renewAppKey(found), 200, { "content-type": "application/x-pem-file" });
      })
  );
}
