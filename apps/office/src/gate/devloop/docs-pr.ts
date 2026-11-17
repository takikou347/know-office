// 設計書の PR の形の確かめ。PR を出す前と main に入れる前が、同じコミットについて同じ確かめを通す (開発の回し方の 3.2)
import { checkServiceDocs, serviceDirs } from "@know-office/core";
import type { Forge } from "../work/loop.ts";

/** サービスの名前の形。道に入れるので、小文字、数字、`.`、`_`、`-` だけで、頭は英数字 */
const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

// 中身を読むファイルの形。knowidea の tools/check.py の置き場と同じ
const READABLE = /^(?:README\.md|docs\/(?:01-overview|02-architecture|03-stack|04-detail|05-test|06-operations)\/index\.md|docs\/(?:04-detail|05-test)\/\d+-[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;

/**
 * 1 回の確かめで中身を読むファイルの上限。Workers の有料プランは 1 回の要求で subrequest を 1,000 まで許す (Cloudflare Workers の Limits)
 * 内訳は、中身の読み 60、変えたファイル 1、木 1、ブランチの先か既定のブランチの先 2、README の読み 1、チェック 1、main を進める 1、レビューと承認の GitHub への写し数回、鍵の取得とインストールの確かめ
 * で、これらを足しても 1,000 に十分収まる。当たったら上限を上げる Issue を立てる
 */
export const DOCS_READ_MAX = 60;

/** 確かめの結果。ok は形が合う、refused は断る、waiting は GitHub が木を切って決められない */
export type DocsPrCheck =
  | { kind: "ok"; name: string; paths: readonly string[] }
  | { kind: "refused"; reason: string; errors: { pointer: string; detail: string }[] }
  | { kind: "waiting"; reason: string };

/**
 * 断る結果を作る
 * @param reason 理由
 * @param errors 直す所
 * @returns 断る結果
 */
function refuse(reason: string, errors: { pointer: string; detail: string }[] = []): DocsPrCheck {
  return { kind: "refused", reason, errors };
}

/**
 * 設計書のリポジトリの PR を、確かめたコミットについて確かめる。変えた道が 1 つの `services/<名前>/` の下だけで、その下の設計書が決まった形である事を見る
 * @param forge GitHub
 * @param repo 設計書のリポジトリ
 * @param sha 確かめるコミット。変えた道、木、中身を全部この 1 つで読む
 * @param known 変えた道が分かっている時に渡す。無ければ GitHub から読む
 * @returns 確かめの結果
 * @throws upstream_failed GitHub から読めない時
 */
export async function verifyDocsPr(forge: Forge, repo: string, sha: string, known?: readonly string[] | null): Promise<DocsPrCheck> {
  const paths = known === undefined ? await forge.changedPaths(repo, sha) : known;
  if (paths === null) return refuse("変えたファイルを確かめ切れない");
  if (paths.length === 0) return refuse("変えたファイルが無い");
  const [name, ...others] = serviceDirs(paths);
  if (name === undefined || others.length > 0 || !SERVICE_NAME.test(name) || name.includes("..")) return refuse("設計書の PR は 1 つの services/<名前>/ の下だけを変える");
  if (!paths.every((p) => p.startsWith(`services/${name}/`))) return refuse("設計書の PR は services/<名前>/ の外を変えない");
  const prefix = `services/${name}/`;
  const listed = await forge.listFiles(repo, sha, prefix);
  if (listed === null) return { kind: "waiting", reason: "設計書の木を読み切れない" };
  // 名前の形を先に確かめ、通った物だけ中身を読む。外れた物は中身を空にして形の確かめに渡し、置き場の外れとして返す
  const relative = listed.map((p) => p.slice(prefix.length));
  const readable = relative.filter((p) => READABLE.test(p));
  if (readable.length > DOCS_READ_MAX) return refuse(`中身を読むファイルが ${String(DOCS_READ_MAX)} 件を超えた`);
  const files = new Map<string, string>(relative.map((p) => [p, ""]));
  for (const path of readable) files.set(path, (await forge.readFile(repo, sha, `${prefix}${path}`)) ?? "");
  const problems = checkServiceDocs(name, files);
  if (problems.length > 0) return refuse("設計書の形が違う", problems.map((p) => ({ pointer: `#/files/${p.path}`, detail: p.detail })));
  return { kind: "ok", name, paths };
}

/**
 * そのサービスの設計書が、設計書のリポジトリの既定のブランチにまだ無い (最初の設計書) かを読む。読みが失敗したら投げる
 * @param forge GitHub
 * @param repo 設計書のリポジトリ
 * @param name サービスの名前
 * @returns README.md がまだ無ければ true
 * @throws upstream_failed GitHub から読めない時
 */
export async function isFirstDocs(forge: Forge, repo: string, name: string): Promise<boolean> {
  // 既定のブランチの先を固定して、その先で読む
  const head = await forge.defaultHead(repo);
  return (await forge.readFile(repo, head, `services/${name}/README.md`)) === null;
}
