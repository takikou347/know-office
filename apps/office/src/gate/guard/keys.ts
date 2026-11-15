// 全体を止めた後の外の鍵の入れ直し。オーナーが入れた GitHub App の秘密鍵と Claude の API の鍵を vault に置き、両方そろったら全体を再開できるようにする (自動停止の 3.5)
import { AppError, type Fetcher, GitHubAppKeys, GitHubInstallation, GitHubInstallationKey, type GuardKeys, type ReplaceGitHubAppKeyInput, Secret } from "@know-office/core";
import { readLatest, storeStatements } from "../auth/vault.ts";
import type { Bindings } from "../env.ts";
import { appJwt, callGitHub, NOT_LINKED, parseGitHub, parseStored } from "../github/app.ts";
import { guardDo, openStop } from "./actions.ts";

/** 全体の止めた記録がまだ再開していない時だけ書く条件。読んで確かめた後に再開されても置かない */
const OFFICE_STOPPED = "EXISTS (SELECT 1 FROM stops s WHERE s.kind = 'stop' AND s.scope = 'office' AND s.target = 'office' AND NOT EXISTS (SELECT 1 FROM stop_updates u WHERE u.stop_id = s.id AND u.kind = 'resumed'))";

/**
 * 入れ直す鍵の今を読む
 * @param env バインディング
 * @returns 印と、まだ入れ直していない鍵
 */
export async function guardKeys(env: Bindings): Promise<GuardKeys> {
  const { held, pending } = await guardDo(env).keyState();
  return { held, pending };
}

/**
 * 全体が止まっている事を確かめ、入れ直す前の世代を読む。入れ直している間に止め直されたら、印を外さないために使う
 * @param env バインディング
 * @returns 印を付けた世代
 * @throws conflict 全体が止まっていない時
 */
async function stoppedGeneration(env: Bindings): Promise<number> {
  if (!(await openStop(env.DB, "office", "office"))) throw new AppError("conflict", "全体が止まっていない");
  return (await guardDo(env).keyState()).generation;
}

/**
 * Claude の API の鍵を入れ直す。読んだ版から書く 1 文で置き、前の版を取り消す
 * @param env バインディング
 * @param apiKey 新しい鍵。形は呼ぶ側が確かめている
 * @param now 今の時刻
 * @returns 入れ直す鍵の今
 * @throws conflict 全体が止まっていない時、同じ時に別の鍵を置いた時
 */
export async function replaceClaudeKey(env: Bindings, apiKey: string, now: number): Promise<GuardKeys> {
  const generation = await stoppedGeneration(env);
  const { top } = await readLatest(env.DB, "claude_api_key", env.MASTER_KEY);
  const statements = await storeStatements(env.DB, { name: "claude_api_key", value: new Secret(JSON.stringify({ apiKey })), top, now, master: env.MASTER_KEY, when: { sql: OFFICE_STOPPED, args: [] } });
  const [written] = await env.DB.batch(statements);
  if ((written?.meta.changes ?? 0) === 0) throw new AppError("conflict", "同じ時に別の鍵を置いた");
  return guardDo(env).releaseKeys("claude", generation);
}

/**
 * GitHub App の鍵を入れ直す。止める前の連携の App とインストールに、作り直した秘密鍵と通知の秘密を付けて置き直す
 * 新しい秘密鍵でインストールを GitHub に聞いてから、App とインストールを 1 回のバッチで置き、片方だけを残さない
 * @param env バインディング
 * @param fetcher 外への fetch
 * @param input 新しい秘密鍵と通知の秘密。形は呼ぶ側が確かめている
 * @param now 今の時刻
 * @returns 入れ直す鍵の今
 * @throws conflict 全体が止まっていない時、止める前の連携が無い時、インストールが外れた時、同じ時に別の鍵を置いた時
 * @throws validation_failed 秘密鍵を読めない時、秘密鍵が App と合わない時
 * @throws upstream_failed GitHub が失敗を返した時
 */
export async function replaceGitHubAppKey(env: Bindings, fetcher: Fetcher, input: ReplaceGitHubAppKeyInput, now: number): Promise<GuardKeys> {
  const generation = await stoppedGeneration(env);
  const [app, installation] = await Promise.all([readLatest(env.DB, "github_app", env.MASTER_KEY), readLatest(env.DB, "github_installation", env.MASTER_KEY)]);
  const keys = parseStored(app.value, GitHubAppKeys);
  const inst = parseStored(installation.value, GitHubInstallationKey);
  if (!keys || !inst) throw new AppError("conflict", "止める前の連携が無い。連携をやり直す");
  const privateKey = new Secret(input.privateKey);
  await checkNewKey(env, fetcher, { appId: keys.appId, privateKey }, inst.id, now);
  const value = new Secret(JSON.stringify({ appId: keys.appId, slug: keys.slug, privateKey: input.privateKey, webhookSecret: input.webhookSecret }));
  const appStatements = await storeStatements(env.DB, {
    name: "github_app",
    value,
    top: app.top,
    now,
    master: env.MASTER_KEY,
    // 全体が止まったままで、まだ使える連携が無く、インストールの版も読んだ時のままの時だけ置く
    when: { sql: `${NOT_LINKED.sql} AND ${OFFICE_STOPPED} AND (SELECT COALESCE(MAX(version), 0) FROM vault WHERE name = 'github_installation') = ?`, args: [installation.top] },
  });
  const installStatements = await storeStatements(env.DB, {
    name: "github_installation",
    value: new Secret(JSON.stringify({ id: inst.id })),
    top: installation.top,
    now,
    master: env.MASTER_KEY,
    // 同じバッチで置いた App の版がある時だけ置く
    when: { sql: "EXISTS (SELECT 1 FROM vault WHERE name = 'github_app' AND version = ? AND revoked_at IS NULL)", args: [app.top + 1] },
  });
  const [written] = await env.DB.batch([...appStatements, ...installStatements]);
  if ((written?.meta.changes ?? 0) === 0) throw new AppError("conflict", "同じ時に別の鍵を置いた");
  return guardDo(env).releaseKeys("github_app", generation);
}

/**
 * 新しい秘密鍵で作った App の JWT で、インストールが同じ App の物かを GitHub に聞く
 * @param env バインディング
 * @param fetcher 外への fetch
 * @param app App ID と新しい秘密鍵
 * @param app.appId App ID
 * @param app.privateKey 新しい秘密鍵
 * @param installationId インストール ID
 * @param now 今の時刻
 * @throws validation_failed 秘密鍵を読めない時、秘密鍵が App と合わない時
 * @throws conflict インストールが外れた時
 * @throws upstream_failed GitHub が失敗を返した時
 */
async function checkNewKey(env: Bindings, fetcher: Fetcher, app: { appId: number; privateKey: Secret }, installationId: number, now: number): Promise<void> {
  let jwt: string;
  try {
    jwt = await appJwt(app, now);
  } catch {
    throw new AppError("validation_failed", "秘密鍵を読めない", { errors: [{ pointer: "#/privateKey", detail: "GitHub App の画面で作った PEM を送る" }] });
  }
  const res = await callGitHub(env, fetcher, `app/installations/${String(installationId)}`, { headers: { authorization: `Bearer ${jwt}` } });
  // GitHub は App の JWT の署名が合わない時に 401 を返す
  if (res.status === 401) throw new AppError("validation_failed", "秘密鍵が App と合わない", { errors: [{ pointer: "#/privateKey", detail: "止める前の連携の App で作った秘密鍵を送る" }] });
  if (res.status === 404) throw new AppError("conflict", "インストールが外れている。連携をやり直す");
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  const found = await parseGitHub(res, GitHubInstallation);
  if (found.app_id !== app.appId || found.id !== installationId) throw new AppError("conflict", "インストールが外れている。連携をやり直す");
}
