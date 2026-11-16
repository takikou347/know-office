// 既定のブランチへの push の通知から、ライブラリの公開 (release) と、ほかのサービスが使うライブラリの版 (uses) を残し、使う側の版が古ければ上げるタスクを足す (サービスと拡張の 3.2)
import { compareSemver, GitHubPushEvent, newId, PackageManifest, type ReleaseDetail, Semver } from "@know-office/core";
import { and, asc, eq, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";
import { nodes, services, serviceEvents } from "../db/main.ts";
import { insertedWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { recordError } from "../ledger/errors.ts";
import { clockAt } from "../work/attendance.ts";
import { type Forge, notifyStaff } from "../work/loop.ts";
import { type Actor, intakeProject, newNodeRow, recordCreated } from "../work/nodes.ts";
import { latestRelease, usersOf } from "./status.ts";

/** ライブラリの公開で読む package.json。knowidea-ui の 4 つのパッケージと説明のサイト。無い道は読まない */
export const LIBRARY_MANIFESTS = ["packages/tokens/package.json", "packages/css/package.json", "packages/icons/package.json", "packages/ui/package.json", "apps/docs/package.json"] as const;

/** 使う側のサービスで、ライブラリの版を読む package.json */
export const DEPENDENCY_MANIFESTS = ["package.json", "apps/office/package.json"] as const;

/** 版を上げるタスクの source の頭。`ui-bump:<使う側のサービス ID>:<版>` で、同じ版のタスクを 1 つにする */
export const BUMP_SOURCE = "ui-bump";

/** push の通知の commits の上限。GitHub はこれを超えた分を並べないので、超えたら全部を読む */
const COMMITS_MAX = 2048;

type ServiceRow = typeof services.$inferSelect;
type Package = { name: string; version: string };

/**
 * push で変わった道を集める。並べきれていない時は null
 * @param push 確かめた push の通知
 * @returns 変わった道。分からなければ null
 */
function changedPaths(push: z.output<typeof GitHubPushEvent>): Set<string> | null {
  if (push.commits === undefined || push.commits.length >= COMMITS_MAX) return null;
  return new Set(push.commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]));
}

/**
 * 読む道を、push で変わった物に絞る
 * @param paths 読む候補
 * @param changed 変わった道。null は全部
 * @returns 読む道
 */
function touched(paths: readonly string[], changed: Set<string> | null): string[] {
  return changed === null ? [...paths] : paths.filter((p) => changed.has(p));
}

/**
 * package.json を読んで形を確かめる。無ければ null、形が違えば "invalid"
 * @param forge GitHub を呼ぶ口
 * @param repo リポジトリ
 * @param commit コミット
 * @param path 道
 * @returns 確かめた中身
 */
async function readManifest(forge: Forge, repo: string, commit: string, path: string): Promise<z.output<typeof PackageManifest> | null | "invalid"> {
  const text = await forge.readFile(repo, commit, path);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "invalid";
  }
  const parsed = PackageManifest.safeParse(json);
  return parsed.success ? parsed.data : "invalid";
}

/**
 * ライブラリのパッケージの版を読む。1 つでも形が違えば、その push では公開を残さない
 * @param forge GitHub を呼ぶ口
 * @param repo リポジトリ
 * @param commit コミット
 * @returns パッケージの名前と版。読めなければ null
 */
async function libraryPackages(forge: Forge, repo: string, commit: string): Promise<Package[] | null> {
  const read = await Promise.all(LIBRARY_MANIFESTS.map((p) => readManifest(forge, repo, commit, p)));
  if (read.includes("invalid")) return null;
  const packages: Package[] = [];
  for (const m of read) {
    if (m === null || m === "invalid") continue;
    const version = Semver.safeParse(m.version);
    if (!version.success) return null;
    packages.push({ name: m.name, version: version.data });
  }
  return packages.length > 0 ? packages : null;
}

/**
 * ライブラリの公開を残す。版の組が前の公開と違い、前より下がっていない時だけ書く。上がった時は使う側に版を上げるタスクを足す
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param library ライブラリのサービスの行
 * @param packages 読んだパッケージ
 * @param commit コミット
 * @param now 今の時刻
 */
async function release(env: Bindings, forge: Forge, library: ServiceRow, packages: Package[], commit: string, now: number): Promise<void> {
  const sorted = packages.toSorted((a, b) => a.name.localeCompare(b.name));
  const version = sorted.map((p) => p.version).reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
  const detail: z.output<typeof ReleaseDetail> = {
    key: sorted.map((p) => `${p.name}@${p.version}`).join(","),
    version,
    packages: sorted,
    aligned: new Set(sorted.map((p) => p.version)).size === 1,
    commit,
  };
  const prev = await latestRelease(env.DB, library.id);
  if (prev && compareSemver(version, prev.detail.version) < 0) return;
  // 同じ組の公開は 1 行だけ。同時に届いた 2 つは一意の索引 (0010) で片方だけが入る
  const written = await env.DB.prepare(
    `INSERT INTO service_events (id, at, service_id, kind, by, detail) SELECT ?, ?, ?, 'release', 'system', ? WHERE NOT EXISTS (SELECT 1 FROM service_events WHERE service_id = ? AND kind = 'release' AND json_extract(detail, '$.key') = ?) ON CONFLICT DO NOTHING`,
  )
    .bind(newId(clockAt(now)), now, library.id, JSON.stringify(detail), library.id, detail.key)
    .run();
  if (written.meta.changes === 0) return;
  if (prev && compareSemver(version, prev.detail.version) === 0) return;
  const users = await usersOf(env.DB, library.id);
  for (const user of users) {
    if (compareSemver(user.version, version) < 0) await bumpTask(env, library, user, version, now);
  }
  await readUnknownUsers(env, forge, new Set(users.map((u) => u.serviceId)), now);
}

/**
 * 使う版をまだ読んでいないサービスの、既定のブランチの package.json を読んで使う版を残す。古ければ recordUses が版を上げるタスクを足す。
 * 1 つのサービスが読めなくても、エラーログに残してほかを読む。公開は書けているので、通知を送り直させない
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param known 使う版を読んだサービス ID
 * @param now 今の時刻
 */
async function readUnknownUsers(env: Bindings, forge: Forge, known: Set<string>, now: number): Promise<void> {
  const others = await drizzle(env.DB)
    .select()
    .from(services)
    .where(and(ne(services.kind, "library"), isNotNull(services.repo), notInArray(services.stage, ["dropped", "closed"])))
    .orderBy(asc(services.id));
  for (const user of others) {
    if (known.has(user.id) || user.repo === null) continue;
    try {
      const head = await forge.defaultHead(user.repo);
      await recordUses(env, user, await readDependencies(forge, user.repo, head, [...DEPENDENCY_MANIFESTS]), head, now);
    } catch (error) {
      await recordError(env, { source: "gate", level: "warn", code: "service_uses_unread", error }, clockAt(now));
    }
  }
}

/**
 * 使う側の package.json の dependencies を合わせて読む。無いか形の違うファイルは数えない
 * @param forge GitHub を呼ぶ口
 * @param repo リポジトリ
 * @param commit コミット
 * @param paths 読む道
 * @returns パッケージの名前から、書いた版
 */
async function readDependencies(forge: Forge, repo: string, commit: string, paths: string[]): Promise<Record<string, string>> {
  const read = await Promise.all(paths.map((p) => readManifest(forge, repo, commit, p)));
  const deps: Record<string, string> = {};
  for (const m of read) if (m !== null && m !== "invalid") Object.assign(deps, m.dependencies ?? {});
  return deps;
}

/**
 * 使う側のサービスに、ライブラリの版を上げるタスクを足す。同じ版のタスクは、終えた後も含めて 1 つだけ
 * @param env バインディング
 * @param library ライブラリのサービスの行
 * @param user 使う側のサービスと、使っている版
 * @param user.serviceId 使う側のサービス ID
 * @param user.staffId 使う側の担当
 * @param user.version 使っている版
 * @param version 公開した版
 * @param now 今の時刻
 */
async function bumpTask(env: Bindings, library: ServiceRow, user: { serviceId: string; staffId: string | null; version: string }, version: string, now: number): Promise<void> {
  const actor: Actor = { by: "system", now };
  const source = `${BUMP_SOURCE}:${user.serviceId}:${version}`;
  const [owner] = await drizzle(env.DB).select({ repo: services.repo }).from(services).where(eq(services.id, user.serviceId)).limit(1);
  const project = await intakeProject(env, user.serviceId, actor);
  const assignee = user.staffId === "president" || user.staffId === "reviewer" ? user.staffId : "builder";
  const task = await newNodeRow(
    env,
    {
      kind: "task",
      parentId: project.id,
      scope: user.serviceId,
      title: `${library.name} を ${user.version} から ${version} に上げる`,
      body: [`${library.name} の ${version} が公開された`, `使っている版: ${user.version}`, "4 つのパッケージをそろえて上げ、チェックを通す"].join("\n"),
      taskKind: "build",
      assignee,
      source,
      ...(owner?.repo ? { repo: owner.repo } : {}),
    },
    actor,
  );
  const written = await insertedWhen(env.DB, nodes, task, sql`NOT EXISTS (SELECT 1 FROM ${nodes} WHERE ${nodes.source} = ${source})`);
  if (!written) return;
  await recordCreated(env, task, actor);
  await notifyStaff(env, assignee, now, false);
}

/**
 * 使う側のサービスが入れているライブラリの版を残す。前に読んだ版と違う時だけ書く。最新の公開より古ければ、版を上げるタスクを足す (同じ版のタスクは 1 つだけ)
 * @param env バインディング
 * @param user 使う側のサービスの行
 * @param deps 読んだ package.json の dependencies を合わせた物
 * @param commit コミット
 * @param now 今の時刻
 */
async function recordUses(env: Bindings, user: ServiceRow, deps: Record<string, string>, commit: string, now: number): Promise<void> {
  const libraries = await drizzle(env.DB).select().from(services).where(eq(services.kind, "library")).orderBy(asc(services.id));
  for (const library of libraries) {
    const released = await latestRelease(env.DB, library.id);
    // 公開を読む前は、サービスの名前と同じパッケージをそのライブラリとみる
    const names = released?.detail.packages.map((p) => p.name) ?? [library.name];
    // ライブラリのパッケージのうち、いちばん古く入れている版をその版とする。範囲の印 (^ と ~) は外し、npm の版でない物は数えない
    const used = names
      .map((name) => Semver.safeParse(deps[name]?.replace(/^[\^~=]/, "")))
      .flatMap((v) => (v.success ? [v.data] : []))
      .reduce<string | null>((a, b) => (a === null || compareSemver(b, a) < 0 ? b : a), null);
    if (used === null) continue;
    const before = (await usersOf(env.DB, library.id)).find((u) => u.serviceId === user.id);
    if (before?.version !== used) {
      await drizzle(env.DB)
        .insert(serviceEvents)
        .values({ id: newId(clockAt(now)), at: now, serviceId: user.id, kind: "uses", by: "system", detail: { library: library.id, version: used, commit } });
    }
    if (released && compareSemver(used, released.detail.version) < 0) await bumpTask(env, library, { serviceId: user.id, staffId: user.staffId, version: used }, released.detail.version, now);
  }
}

/**
 * 既定のブランチへの push を受ける。同じリポジトリを持つサービスが複数あれば、ライブラリはどれも公開を残し、ほかはどれも使う版を残す
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param payload 通知の本文
 * @param now 今の時刻
 */
export async function receivePush(env: Bindings, forge: Forge, payload: unknown, now: number): Promise<void> {
  const parsed = GitHubPushEvent.safeParse(payload);
  if (!parsed.success) return;
  const push = parsed.data;
  if (push.ref !== `refs/heads/${push.repository.default_branch}`) return;
  const repo = push.repository.full_name;
  const owners = await drizzle(env.DB).select().from(services).where(eq(services.repo, repo)).orderBy(asc(services.id));
  if (owners.length === 0) return;
  const changed = changedPaths(push);
  const libraries = owners.filter((s) => s.kind === "library");
  if (libraries.length > 0 && touched(LIBRARY_MANIFESTS, changed).length > 0) {
    const packages = await libraryPackages(forge, repo, push.after);
    if (packages) for (const library of libraries) await release(env, forge, library, packages, push.after, now);
  }
  const users = owners.filter((s) => s.kind !== "library");
  const paths = touched(DEPENDENCY_MANIFESTS, changed);
  if (users.length === 0 || paths.length === 0) return;
  const deps = await readDependencies(forge, repo, push.after, paths);
  for (const user of users) await recordUses(env, user, deps, push.after, now);
}
