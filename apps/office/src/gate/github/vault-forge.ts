// 最初に使う時に vault を読み、つないでいれば GitHub を呼ぶ口になる Forge (GitHub の連携の 3.2)
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import { lazyDevIssues } from "../devloop/dev-issues.ts";
import { type Forge, UNCONNECTED_FORGE } from "../work/loop.ts";
import { githubToken, loadLink, type TokenDeps } from "./app.ts";
import { type GitHubAccess, httpForge } from "./forge.ts";

/**
 * vault の App の鍵から鍵を出す口を作る
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @param appId App ID
 * @returns 鍵の出し手
 */
function vaultAccess(env: Bindings, deps: TokenDeps, appId: number): GitHubAccess {
  return { appId, token: async (repo, permissions) => (await githubToken(env, deps, repo, permissions)).reveal() };
}

/**
 * 最初に使う時に vault を読み、つないでいれば GitHub を呼ぶ口、つないでいなければ断る口になる口を作る
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @returns GitHub を呼ぶ口
 */
export function vaultForge(env: Bindings, deps: TokenDeps): Forge {
  let loaded: Promise<Forge> | null = null;
  const load = (): Promise<Forge> => {
    loaded ??= loadLink(env).then((link) => (link.app && link.installation ? httpForge(endpoints(env).github, deps.fetcher, vaultAccess(env, deps, link.app.appId), deps.pause === undefined ? {} : { pause: deps.pause }) : UNCONNECTED_FORGE));
    return loaded;
  };
  return {
    openPull: async (input) => (await load()).openPull(input),
    pullState: async (repo, pr) => (await load()).pullState(repo, pr),
    checkState: async (repo, sha) => (await load()).checkState(repo, sha),
    merge: async (repo, head) => (await load()).merge(repo, head),
    fastForwardable: async (repo, sha) => (await load()).fastForwardable(repo, sha),
    pullOf: async (repo, branch) => (await load()).pullOf(repo, branch),
    inMain: async (repo, sha) => (await load()).inMain(repo, sha),
    changedPaths: async (repo, head) => (await load()).changedPaths(repo, head),
    protectMain: async (repo, when) => (await load()).protectMain(repo, when),
    connected: async () => (await load()).connected(),
    postReview: async (repo, pr, review) => (await load()).postReview(repo, pr, review),
    postComment: async (repo, pr, comment) => (await load()).postComment(repo, pr, comment),
    postStatus: async (repo, sha, status) => (await load()).postStatus(repo, sha, status),
    commitFile: async (repo, branch, change) => (await load()).commitFile(repo, branch, change),
    findMirror: async (repo, pr, kind, marker) => (await load()).findMirror(repo, pr, kind, marker),
    pullFiles: async (repo, pr) => (await load()).pullFiles(repo, pr),
    compare: async (repo, base, head) => (await load()).compare(repo, base, head),
    readFile: async (repo, ref, path) => (await load()).readFile(repo, ref, path),
    dispatchWorkflow: async (repo, workflow, inputs) => (await load()).dispatchWorkflow(repo, workflow, inputs),
    defaultHead: async (repo) => (await load()).defaultHead(repo),
    branchHead: async (repo, branch) => (await load()).branchHead(repo, branch),
    findBranchHead: async (repo, branch) => (await load()).findBranchHead(repo, branch),
    listFiles: async (repo, ref, prefix) => (await load()).listFiles(repo, ref, prefix),
    issues: lazyDevIssues(async () => (await load()).issues),
  };
}
