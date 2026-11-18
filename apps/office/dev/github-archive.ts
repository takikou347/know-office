// 代わりの GitHub の tarball。本物と同じく API は 302 で codeload の形の道を返し、codeload の道は出した印を 1 回だけ受ける (タスクとレビューの 3.6)
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

/** 代わりの tarball の置き場 */
export type FakeArchives = {
  /** 「owner/name:sha」ごとの tar.gz */
  archives: Map<string, Uint8Array>;
  /** API の道 GET /repos/{o}/{r}/tarball/{ref} に答える。tarball の道でなければ null */
  answer(route: string): Response | null;
  /** codeload の形の道 GET /{o}/{r}/legacy.tar.gz/{ref}?token= */
  codeload: Hono;
  /** 通しが木を置く道 PUT /{o}/{r}/{sha} (本文は tar.gz) と、外す道 DELETE /{o}/{r}/{sha} */
  place: Hono;
};

const TARBALL = /^GET \/repos\/([^/]+\/[^/]+)\/tarball\/([^/?]+)$/;

/**
 * 代わりの tarball を作る
 * @param codeloadBase 302 の先の宛先。本番は https://codeload.github.com、手元は代わりの物の置き場の /codeload
 * @returns 置き場、API の答え方、codeload の Hono
 */
export function createFakeArchives(codeloadBase: string): FakeArchives {
  const archives = new Map<string, Uint8Array>();
  /** 出した 1 回だけの印。印から「owner/name:sha」 */
  const issued = new Map<string, string>();
  const answer = (route: string): Response | null => {
    const match = TARBALL.exec(route);
    if (!match) return null;
    const [, repo = "", ref = ""] = match;
    const key = `${repo}:${decodeURIComponent(ref)}`;
    // 本物と同じく、無いコミットは 404
    if (!archives.has(key)) return Response.json({ message: "Not Found" }, { status: 404 });
    const token = randomUUID();
    issued.set(token, key);
    return new Response(null, { status: 302, headers: { location: `${codeloadBase}/${repo}/legacy.tar.gz/${ref}?token=${token}` } });
  };
  const codeload = new Hono().get("/:owner/:name/legacy.tar.gz/:ref", (c) => {
    // 鍵を付けた要求は、ゲートウェイが鍵を codeload に渡した印なので断る
    if (c.req.header("authorization") !== undefined) return c.body(null, 400);
    const token = c.req.query("token") ?? "";
    const key = issued.get(token);
    issued.delete(token);
    if (key === undefined || key !== `${c.req.param("owner")}/${c.req.param("name")}:${c.req.param("ref")}`) return c.body(null, 404);
    const body = archives.get(key);
    if (body === undefined) return c.body(null, 404);
    return new Response(new Uint8Array(body), { headers: { "content-type": "application/x-gzip" } });
  });
  // レビューの補完の通しが、先のコミットの tarball として読ませる木を置く
  const place = new Hono()
    .put("/:owner/:name/:sha", async (c) => {
      const sha = c.req.param("sha");
      if (!/^[0-9a-f]{40}$/.test(sha)) return c.body(null, 400);
      archives.set(`${c.req.param("owner")}/${c.req.param("name")}:${sha}`, new Uint8Array(await c.req.arrayBuffer()));
      return c.body(null, 204);
    })
    .delete("/:owner/:name/:sha", (c) => {
      archives.delete(`${c.req.param("owner")}/${c.req.param("name")}:${c.req.param("sha")}`);
      return c.body(null, 204);
    });
  return { archives, answer, codeload, place };
}
