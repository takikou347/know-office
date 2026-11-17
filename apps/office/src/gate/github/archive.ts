// エディタの補完の木を GitHub の tarball から取る。読む鍵で取り、302 は 1 回だけ手で追い、codeload の先へは鍵を付けずに流す (タスクとレビューの 3.6)
import { AppError, allowedFetch, type Fetcher, LSP_TREE_BYTES, LspTreeParams, RepoName } from "@know-office/core";
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import type { GitHubAccess } from "./forge.ts";
import { GITHUB_USER_AGENT, githubRateLimited, githubRetryAfter, githubToken, type TokenDeps } from "./app.ts";

/** tarball を取る待ち (30 秒)。木は 50MiB まで */
const ARCHIVE_TIMEOUT_MS = 30_000;

/** tarball の取り方 */
export type ArchiveDeps = {
  /** GitHub の REST API の宛先 (本番は https://api.github.com) */
  base: string;
  /** 302 の先として受ける宛先 (本番は https://codeload.github.com)。この下の道だけを追う */
  codeload: string;
  /** 外への fetch */
  fetcher: Fetcher;
  /** 鍵の出し手 */
  access: Pick<GitHubAccess, "token">;
};

/**
 * 302 の先を確かめる。決めた宛先の下で、利用者名とパスワードを持たない https の道だけを通す
 * @param location 302 の Location
 * @param codeload 決めた宛先
 * @returns 追う URL
 * @throws upstream_failed 決めた宛先でない時
 */
function codeloadUrl(location: string | null, codeload: string): string {
  const prefix = `${codeload.replace(/\/$/, "")}/`;
  let url: URL;
  try {
    // 相対の道は宛先が決まらないので、基にする URL を渡さずに断る
    url = new URL(location ?? "");
  } catch {
    throw new AppError("upstream_failed", "tarball の行き先の形が違う");
  }
  // 利用者名とパスワードは、宛先の比べに頼らずに先に断る
  if (url.username !== "" || url.password !== "") throw new AppError("upstream_failed", "tarball の行き先が利用者名かパスワードを持つ");
  // 頭の文字列で比べるので、codeload.github.com.example.com、別のホストの道、http、ほかの番号を通さない
  if (!url.href.startsWith(prefix)) throw new AppError("upstream_failed", "tarball の行き先が codeload でない");
  return url.href;
}

/**
 * 返事の本文を読まずに捨ててから断る。捨てないと接続が残る
 * @param res 返事
 * @param error 投げる物
 * @returns 返さない
 * @throws AppError 渡した物
 */
async function refuse(res: Response, error: AppError): Promise<never> {
  await res.body?.cancel().catch(() => undefined);
  throw error;
}

/**
 * 流れを数え、上限を超えたら止める
 * @param body 流れ
 * @returns 数える流れ
 */
function limited(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > LSP_TREE_BYTES) controller.error(new AppError("upstream_failed", "tarball が大きすぎる"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * リポジトリのコミットの tarball を開く。中身はためずに流す
 * GitHub の REST API の「Download a repository archive (tar)」(GET /repos/{owner}/{repo}/tarball/{ref}) は 302 で codeload.github.com の短い間だけ使える URL を返す。contents: read の鍵で呼ぶ
 * @param deps 宛先、fetch、鍵の出し手
 * @param repo リポジトリ
 * @param sha コミット。40 字の小文字の 16 進
 * @returns tar.gz の流れ。50MiB を超えたら途中で upstream_failed で止まる
 * @throws upstream_failed 形が違う時、GitHub が失敗を返した時、302 の先が codeload でない時、もう 1 度リダイレクトした時、大きすぎる時
 * @throws not_found コミットが無い時
 * @throws rate_limited GitHub の上限に当たった時
 */
export async function openArchive(deps: ArchiveDeps, repo: string, sha: string): Promise<ReadableStream<Uint8Array>> {
  const name = RepoName.safeParse(repo);
  const ref = LspTreeParams.shape.sha.safeParse(sha);
  if (!name.success || !ref.success) throw new AppError("upstream_failed", "リポジトリかコミットの形が違う");
  const root = `${deps.base.replace(/\/$/, "")}/`;
  const token = await deps.access.token(name.data, { contents: "read" });
  let first: Response;
  try {
    first = await allowedFetch(deps.fetcher, `${root}repos/${name.data}/tarball/${ref.data}`, [root], {
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": GITHUB_USER_AGENT },
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("upstream_failed", "GitHub に届かない");
  }
  const wait = githubRetryAfter(first);
  if (wait !== null) return refuse(first, githubRateLimited(wait));
  if (first.status === 404) return refuse(first, new AppError("not_found", "コミットが無い"));
  if (first.status !== 302) return refuse(first, new AppError("upstream_failed", `GitHub が ${String(first.status)} を返した`));
  // 302 の本文は使わない
  await first.body?.cancel().catch(() => undefined);
  const target = codeloadUrl(first.headers.get("location"), deps.codeload);
  let second: Response;
  try {
    // 302 の先は短い間だけ使える URL そのものが鍵なので、Authorization を付けない。もう 1 度のリダイレクトは追わない
    second = await allowedFetch(deps.fetcher, target, [`${deps.codeload.replace(/\/$/, "")}/`], {
      redirect: "manual",
      headers: { "user-agent": GITHUB_USER_AGENT },
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
  } catch {
    throw new AppError("upstream_failed", "codeload に届かない");
  }
  if (second.status >= 300 && second.status < 400) return refuse(second, new AppError("upstream_failed", "codeload がもう 1 度リダイレクトした"));
  // 返事の URL は要求の URL と同じはず。途中で別の所に替わっていれば受けない
  if (second.url !== "" && !second.url.startsWith(`${deps.codeload.replace(/\/$/, "")}/`)) return refuse(second, new AppError("upstream_failed", "codeload の返事の宛先が違う"));
  if (!second.ok || second.body === null) return refuse(second, new AppError("upstream_failed", `codeload が ${String(second.status)} を返した`));
  if (Number(second.headers.get("content-length") ?? "0") > LSP_TREE_BYTES) return refuse(second, new AppError("upstream_failed", "tarball が大きすぎる"));
  return limited(second.body);
}

/**
 * vault の App の鍵から読む鍵を作って tarball を開く口を作る
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @returns tarball を開く口
 */
export function vaultArchive(env: Bindings, deps: TokenDeps): (repo: string, sha: string) => Promise<ReadableStream<Uint8Array>> {
  return (repo, sha) => {
    const ends = endpoints(env);
    return openArchive({ base: ends.github, codeload: ends.codeload, fetcher: deps.fetcher, access: { token: async (r, permissions) => (await githubToken(env, deps, r, permissions)).reveal() } }, repo, sha);
  };
}

/**
 * 決まった鍵の出し手で tarball を開く口を作る。テストが鍵の出し手を渡した時に使う
 * @param env バインディング
 * @param fetcher 外への fetch
 * @param access 鍵の出し手
 * @returns tarball を開く口
 */
export function accessArchive(env: Bindings, fetcher: Fetcher, access: Pick<GitHubAccess, "token">): (repo: string, sha: string) => Promise<ReadableStream<Uint8Array>> {
  return (repo, sha) => {
    const ends = endpoints(env);
    return openArchive({ base: ends.github, codeload: ends.codeload, fetcher, access }, repo, sha);
  };
}
