// 設計書の PR の形の確かめ。PR を出す前と main に入れる前が、同じコミットについて同じ確かめを通す (開発の回し方の 3.2)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, checkServiceDocs, SERVICE_NAME, serviceDirs } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { services } from "../db/main.ts";
import type { Forge } from "../work/loop.ts";

/** 最初の設計書の PR が一覧の行を足してよい、サービスの一覧。knowidea の tools/check.py が、サービスごとに `(<名前>/README.md)` の行を一覧に要求する */
const INDEX = "services/README.md";

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
 * サービスの一覧 `services/README.md` の変えた所が、`(<名前>/README.md)` を含む行の追加 1 つだけかを、既定のブランチの先と確かめるコミットの 2 回の読みで確かめる。消した行や変えた行があれば断る
 * @param forge GitHub
 * @param repo 設計書のリポジトリ
 * @param sha 確かめるコミット
 * @param name サービスの名前
 * @returns 断る結果。通せば null
 * @throws upstream_failed GitHub から読めない時
 */
async function checkIndexLine(forge: Forge, repo: string, sha: string, name: string): Promise<DocsPrCheck | null> {
  const base = await forge.readFile(repo, await forge.defaultHead(repo), INDEX);
  const next = await forge.readFile(repo, sha, INDEX);
  const bad = (detail: string) => refuse("サービスの一覧は、自分の行を 1 行足すだけにする", [{ pointer: `#/files/${INDEX}`, detail }]);
  if (base === null || next === null) return bad("既定のブランチと PR の先の両方に一覧が要る");
  const [before, after] = [base.split("\n"), next.split("\n")];
  if (after.length !== before.length + 1) return bad("足す行はちょうど 1 行にする");
  // 最初に食い違う所が足した行で、その後ろは元と同じでなければならない
  let at = before.findIndex((line, i) => line !== after[i]);
  if (at < 0) at = before.length;
  const added = after[at] ?? "";
  if (!added.includes(`(${name}/README.md)`)) return bad(`足す行に (${name}/README.md) を含める`);
  if (after.slice(at + 1).join("\n") !== before.slice(at).join("\n")) return bad("ほかの行を変えない");
  return null;
}

/**
 * 設計書のリポジトリの PR を、確かめたコミットについて確かめる。変えた道が 1 つの `services/<名前>/` の下だけ (と、自分の行を足すサービスの一覧) で、その下の設計書が決まった形である事を見る
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
  const own = paths.filter((p) => p !== INDEX);
  const [name, ...others] = serviceDirs(own);
  if (name === undefined || others.length > 0 || !SERVICE_NAME.test(name) || name.includes("..")) return refuse("設計書の PR は 1 つの services/<名前>/ の下だけを変える");
  if (!own.every((p) => p.startsWith(`services/${name}/`))) return refuse("設計書の PR は services/<名前>/ の外を変えない。変えてよいのは services/README.md の自分の行だけ");
  const prefix = `services/${name}/`;
  if (paths.includes(INDEX)) {
    const index = await checkIndexLine(forge, repo, sha, name);
    if (index !== null) return index;
  }
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

/**
 * 設計書の PR を出す前に確かめ、外れていれば断る。設計書を書くタスク (source が design:<サービス ID>) は、そのサービスの置き場 `services/<リポジトリの名前を小文字にした物>/` だけを変えられる。別のサービスの設計書を書き換えさせない
 * @param db 今の状態の D1
 * @param forge GitHub
 * @param task 出すタスクのリポジトリ、範囲、出どころ
 * @param task.repo 設計書のリポジトリ
 * @param task.scope タスクの範囲。設計書を書くタスクではサービス ID
 * @param task.source タスクの出どころ
 * @param head ブランチの先として固定したコミット
 * @throws validation_failed 設計書の形が違う時、設計書を書くタスクが別のサービスの置き場を変える時
 * @throws upstream_failed 設計書の木を読み切れない時、GitHub から読めない時
 */
export async function assertDocsPr(db: D1Database, forge: Forge, task: { repo: string | null; scope: string; source: string | null }, head: string): Promise<void> {
  if (task.repo === null) throw new AppError("internal", "設計書のタスクにリポジトリが無い");
  const shape = await verifyDocsPr(forge, task.repo, head);
  if (shape.kind === "refused") throw new AppError("validation_failed", shape.reason, { errors: shape.errors });
  if (shape.kind === "waiting") throw new AppError("upstream_failed", shape.reason);
  if (task.source?.startsWith("design:") !== true) return;
  const [owner] = await drizzle(db).select({ repo: services.repo }).from(services).where(eq(services.id, task.scope)).limit(1);
  const expected = owner?.repo?.split("/")[1]?.toLowerCase();
  if (expected !== shape.name) throw new AppError("validation_failed", "設計書を書くタスクは、そのサービスの services/<名前>/ だけを変える", { errors: [{ pointer: "#/files", detail: `変えてよい置き場は services/${expected ?? "<名前>"}/` }] });
}
