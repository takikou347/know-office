// 設計書を同じ時に直すテストの手伝い。サービスの子 Issue のタスクを開発担当に取らせ、設計書のリポジトリとサービスのリポジトリで別々に動く代わりの GitHub を、world.forge に重ねる (開発の回し方の 3.6)
import type { CheckState } from "@know-office/core";
import { expect } from "vitest";
import { DOCS, GOOD, HEAD, MAIN } from "./docs.ts";
import { child, pacedForge, planOf, plan, withDocs } from "./issues.ts";
import { clockIn, REPO, rows, type WorkWorld } from "./work.ts";

/** 設計書の PR が変える道。形の確かめに通る */
export const DOC_FILE = "services/video-maker/docs/01-overview/index.md";
/** 設計書の PR のブランチの先 */
export const DOCS_HEAD = "e".repeat(40);
/** 押された後の、設計書の PR のブランチの先 */
export const DOCS_NEXT = "f".repeat(40);
/** コードの PR のブランチの先 (fakeForge の openPull が返す) */
export const CODE_HEAD = "b".repeat(40);

/** リポジトリごとに動く代わりの GitHub の記録と操作 */
export type Repos = {
  /** main に入れた呼びを順に並べた「リポジトリ:先」 */
  merges: string[];
  /** 出した PR の「リポジトリ:ブランチ」 */
  opened: string[];
  /** 「リポジトリ:ブランチ」ごとの先 */
  heads: Map<string, string>;
  /** リポジトリごとの main に入れたコミット */
  landed: Set<string>;
  /** リポジトリごとのチェック */
  checks: Record<string, CheckState>;
  /** 次に merge を呼んだ時 behind にするリポジトリ */
  behind: Set<string>;
  /** 次に merge を呼んだ時 GitHub の失敗にするリポジトリ */
  broken: Set<string>;
  /** 開いている PR の「リポジトリ:ブランチ」ごとの番号 */
  pulls: Map<string, number>;
  /** 設計書のリポジトリの PR の次の番号 */
  next: { docs: number };
  /** main に fast-forward で進められないリポジトリ */
  stale: Set<string>;
  /** 設計書の PR の先にある設計書のファイル。道は設計書のリポジトリの頭から */
  files: Record<string, string>;
};

/**
 * world.forge を、設計書のリポジトリとサービスのリポジトリで別々に動く物に差し替える
 * @param world テストの物
 * @returns 記録と操作
 */
export function splitForge(world: WorkWorld): Repos {
  const repos: Repos = { merges: [], opened: [], heads: new Map(), landed: new Set(), checks: { [DOCS]: "passed", [REPO]: "passed" }, behind: new Set(), broken: new Set(), pulls: new Map(), next: { docs: 10 }, stale: new Set(), files: { ...GOOD } };
  const forge = world.forge;
  const files = repos.files;
  forge.changedPaths = (repo) => Promise.resolve(repo === DOCS ? [DOC_FILE] : []);
  forge.defaultHead = () => Promise.resolve(HEAD);
  forge.branchHead = (repo, branch) => Promise.resolve(repos.heads.get(`${repo}:${branch}`) ?? (repo === DOCS ? DOCS_HEAD : CODE_HEAD));
  forge.listFiles = (repo, _ref, prefix) => Promise.resolve(repo === DOCS ? Object.keys(files).filter((p) => p.startsWith(prefix)) : []);
  forge.readFile = (repo, ref, path) => Promise.resolve(repo === DOCS && (ref === HEAD || ref === MAIN || ref === DOCS_HEAD || ref === DOCS_NEXT) ? (files[path] ?? null) : null);
  forge.checkState = (repo) => Promise.resolve(repos.checks[repo] ?? "passed");
  forge.openPull = (input) => {
    repos.opened.push(`${input.repo}:${input.branch}`);
    forge.pulls.push({ repo: input.repo, branch: input.branch, title: input.title });
    forge.bodies.push(input.body);
    const number = input.repo === DOCS ? (repos.next.docs += 1) : forge.pulls.length;
    repos.pulls.set(`${input.repo}:${input.branch}`, number);
    return Promise.resolve({ number, baseSha: "a".repeat(40), headSha: input.repo === DOCS ? (repos.heads.get(`${input.repo}:${input.branch}`) ?? DOCS_HEAD) : CODE_HEAD });
  };
  forge.pullOf = (repo, branch) => {
    const number = repos.pulls.get(`${repo}:${branch}`);
    return Promise.resolve(number === undefined ? null : { number, baseSha: "a".repeat(40), headSha: repos.heads.get(`${repo}:${branch}`) ?? (repo === DOCS ? DOCS_HEAD : CODE_HEAD) });
  };
  forge.fastForwardable = (repo) => Promise.resolve(!repos.stale.has(repo));
  forge.merge = async (repo, head) => {
    await forge.during.merge?.();
    if (repos.broken.has(repo)) throw new Error("GitHub が main を進める更新を断った");
    if (repos.behind.has(repo)) return "behind";
    repos.merges.push(`${repo}:${head.sha}`);
    repos.landed.add(`${repo}:${head.sha}`);
    return "merged";
  };
  forge.inMain = (repo, sha) => Promise.resolve(repos.landed.has(`${repo}:${sha}`));
  return repos;
}

/**
 * 設計書の置き場の機能のファイルに要件が 1 つある設計書で、子 1 件のタスクを開発担当に取らせる。変えたファイルはテストのファイルを含める
 * @param world テストの物
 * @returns サービス ID、Issue の番号、タスク ID、代わりの GitHub の操作
 */
export async function working(world: WorkWorld): Promise<{ service: string; number: number; task: string; repos: Repos }> {
  const service = await withDocs(world);
  await world.d1.DB.prepare("UPDATE nodes SET status = 'dropped' WHERE title LIKE '設計書:%'").run();
  await clockIn(world, "president", "builder", "reviewer");
  const made = await plan(world, planOf(service, [child("動画を作る", { kind: "chore" })]));
  const number = made.children[0]?.number ?? 0;
  const repos = splitForge(world);
  world.forge.issues = pacedForge(world).issues;
  const [task] = await rows(world.d1.DB, "SELECT id, status FROM nodes WHERE source = ?", `issue:${String(number)}`);
  expect(task?.["status"]).toBe("doing");
  return { service, number, task: String(task?.["id"]), repos };
}

/**
 * タスクの行を写した、別のタスクを足す。同じサービスの設計書を直す、別のタスクの代わり
 * @param world テストの物
 * @param from 写すタスク ID
 * @param status 写したタスクの状態
 * @param docs 設計書の PR の行を持たせるか
 * @returns 足したタスクの ID
 */
export async function otherTask(world: WorkWorld, from: string, status: string, docs = true): Promise<string> {
  const [row] = await rows(world.d1.DB, "SELECT * FROM nodes WHERE id = ?", from);
  const id = crypto.randomUUID();
  const copy = { ...row, id, status, source: `other:${id}`, issue_number: null, pr_number: null, branch: null };
  const names = Object.keys(copy);
  await world.d1.DB.prepare(`INSERT INTO nodes (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).bind(...Object.values(copy)).run();
  if (docs) await world.d1.DB.prepare("INSERT INTO task_docs (node_id, service_id, repo, pr_number, branch, created_at) VALUES (?, ?, ?, ?, ?, 1)").bind(id, String(row?.["scope"]), DOCS, 90, `ko/${id.slice(0, 8)}-other`).run();
  return id;
}
