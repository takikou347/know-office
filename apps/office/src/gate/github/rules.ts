// GitHub のルール。触れるリポジトリを読み書きし、リポジトリに効く設定を組み立て、公開のリポジトリにルールセットを掛け直す (GitHub の連携の 3.3)
import type { D1Database } from "@cloudflare/workers-types";
import { AppError, docsMergeNeeds, type GitHubRules, GitHubRulesValue, INHERITED_SETTINGS, newId, type ServiceRules } from "@know-office/core";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { services, settings } from "../db/main.ts";
import { isDocsRepo } from "../devloop/docs-setting.ts";
import type { Bindings } from "../env.ts";
import { DEFAULT_PREFIX, loadOfficeDefaults, serviceRules } from "../services/settings.ts";
import { clockAt } from "../work/attendance.ts";
import type { Forge } from "../work/loop.ts";

// office の初期値をまとめて確かめる形
const OFFICE_RULES = z.object(INHERITED_SETTINGS);

/** GitHub のルールを置く `settings` のキー */
export const RULES_KEY = "github.rules";

/**
 * GitHub のルールの最新の値を読む。行が無ければ、連携したものすべてに触れる初期値を版 0 で返す
 * @param db 今の状態の D1
 * @returns 触れるリポジトリと版
 * @throws internal 置いた値の形が違う時
 */
export async function loadGitHubRules(db: D1Database): Promise<GitHubRules> {
  const [row] = await drizzle(db)
    .select({ value: settings.value, version: settings.version })
    .from(settings)
    .where(and(eq(settings.key, RULES_KEY), eq(settings.scope, "office")))
    .orderBy(desc(settings.version))
    .limit(1);
  if (!row) return { repos: null, version: 0 };
  // 形の違う値で判断すると触れるリポジトリの守りが外れるので、読めない時は失敗にする
  const value = GitHubRulesValue.safeParse(row.value);
  if (!value.success) throw new AppError("internal", "settings の github.rules の形が違う");
  return { repos: value.data.repos, version: row.version };
}

/**
 * GitHub のルールを変える。今の版が読んだ版と同じ時だけ書く 1 文で、同時に変えた 2 つの片方を断る
 * @param db 今の状態の D1
 * @param input 触れるリポジトリ、読んだ版、理由、今の時刻
 * @param input.repos 触れるリポジトリ。null は連携したものすべて
 * @param input.version 読んだ版
 * @param input.reason 理由
 * @param input.now 今の時刻
 * @returns 変えた後のルール
 * @throws conflict 版が違う時
 */
export async function updateGitHubRules(db: D1Database, input: { repos: string[] | null; version: number; reason: string; now: number }): Promise<GitHubRules> {
  const { repos, version, reason, now } = input;
  const next = version + 1;
  const written = await drizzle(db)
    .insert(settings)
    .select(
      sql`SELECT ${newId(clockAt(now))}, ${RULES_KEY}, 'office', ${JSON.stringify({ repos })}, ${next}, 'owner', ${reason}, ${now} WHERE COALESCE((SELECT MAX(${settings.version}) FROM ${settings} WHERE ${settings.key} = ${RULES_KEY} AND ${settings.scope} = 'office'), 0) = ${version}`,
    )
    .returning({ id: settings.id });
  if (written.length === 0) throw new AppError("conflict", "バージョンが違う");
  return { repos, version: next };
}

/**
 * 同じリポジトリを持つサービスの設定を、強い側に寄せて 1 つにする。できる操作は共通の物、条件と触れない所は足し合わせ、どれかが止めていれば止める
 * @param all サービスごとの設定
 * @returns 合わせた設定
 */
function strictest(all: readonly ServiceRules[]): ServiceRules {
  const [first, ...rest] = all;
  if (!first) throw new AppError("internal", "合わせる設定が無い");
  const union = <T>(pick: (r: ServiceRules) => readonly T[]): T[] => [...new Set(all.flatMap(pick))];
  return {
    actions: first.actions.filter((a) => rest.every((r) => r.actions.includes(a))),
    mergeWhen: union((r) => r.mergeWhen),
    deployWhen: union((r) => r.deployWhen),
    protectedPaths: union((r) => r.protectedPaths),
    paused: all.some((r) => r.paused),
  };
}

/**
 * リポジトリへの操作の判断に使う、触れるリポジトリとそのリポジトリに効く設定を、判断のたびに読む
 * そのリポジトリのサービスがあればその設定、設計書のリポジトリなら office の初期値のできる操作と触れない所に設計書の main に入れる条件、どれでもなければ office の初期値を使う
 * @param db 今の状態の D1
 * @param repo リポジトリ
 * @returns 触れるリポジトリ、設定、設計書のリポジトリか
 * @throws internal 置いた値の形が違う時
 */
export async function repoScope(db: D1Database, repo: string): Promise<{ repos: readonly string[] | null; rules: ServiceRules; docs: boolean }> {
  const [rules, owners] = await Promise.all([loadGitHubRules(db), drizzle(db).select({ id: services.id }).from(services).where(eq(services.repo, repo))]);
  // サービスが持つリポジトリは、設計書のリポジトリに選べない (PUT と試作に進める時が断る)。食い違って持たれていたら普通のルールにする
  if (owners.length > 0) return { repos: rules.repos, rules: strictest(await Promise.all(owners.map((s) => serviceRules(db, s.id)))), docs: false };
  const defaults = await loadOfficeDefaults(db);
  const office = OFFICE_RULES.parse(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.value])));
  // 設計書のリポジトリの main に入れる条件は、office とサービスの設定を読まず、core の docsMergeNeeds で決める。できる操作と触れない所は設定で守る
  if (await isDocsRepo(db, repo)) return { repos: rules.repos, rules: { ...office, mergeWhen: docsMergeNeeds(false) }, docs: true };
  return { repos: rules.repos, rules: office, docs: false };
}

/**
 * 公開のリポジトリに、main に入れる条件と同じルールセットを掛け直す。つないでいない間は掛ける先が無いので何もしない
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param serviceId 1 つのサービスのリポジトリだけを掛け直す時のサービス ID。無ければサービスと触れるリポジトリのすべて
 * @returns 掛けたリポジトリ
 * @throws upstream_failed GitHub が失敗を返した時、返事の形が違う時
 */
export async function protectRepos(env: Bindings, forge: Forge, serviceId?: string): Promise<string[]> {
  if (!(await forge.connected())) return [];
  const orm = drizzle(env.DB);
  const rules = await loadGitHubRules(env.DB);
  const owned = await orm
    .select({ repo: services.repo })
    .from(services)
    .where(serviceId === undefined ? isNotNull(services.repo) : eq(services.id, serviceId));
  const repos = new Set<string>([...owned.flatMap((s) => (s.repo === null ? [] : [s.repo])), ...(serviceId === undefined ? (rules.repos ?? []) : [])]);
  const applied: string[] = [];
  for (const repo of repos) {
    // 触れるリポジトリの外は App で触れないので掛けない
    if (rules.repos !== null && !rules.repos.includes(repo)) continue;
    const scope = await repoScope(env.DB, repo);
    if ((await forge.protectMain(repo, scope.rules.mergeWhen)) === "applied") applied.push(repo);
  }
  return applied;
}

/** office の初期値の `service.mergeWhen` のキー。変えた時はルールセットを掛け直す */
export const MERGE_WHEN_KEY = `${DEFAULT_PREFIX}mergeWhen`;
