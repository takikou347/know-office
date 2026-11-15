// GitHub App の鍵。manifest と state を作り、vault の元の鍵から App の JWT と、リポジトリと権限を絞った 1 時間の鍵を作ってためる (タスクとレビューの 3.2、3.3)
import {
  AppError,
  allowedFetch,
  canonicalJson,
  type Clock,
  type Fetcher,
  fromBase64,
  fromBase64url,
  GitHubAccessToken,
  GitHubAppConversion,
  GitHubAppKeys,
  GitHubInstallation,
  GitHubInstallationKey,
  RepoName,
  Secret,
  toBase64url,
} from "@know-office/core";
import { SignJWT } from "jose";
import { z, type ZodType } from "zod";
import { signingKey } from "../auth/session.ts";
import { readStored, revokeStatement, vaultKey } from "../auth/vault.ts";
import { endpoints } from "../endpoints.ts";
import type { Bindings } from "../env.ts";
import { auditFrom } from "../ledger/record.ts";
import { type Forge, UNCONNECTED_FORGE } from "../work/loop.ts";
import { type GitHubAccess, httpForge, type Permissions } from "./forge.ts";

/** state が効く長さ (10 分) */
export const STATE_MS = 10 * 60_000;
/** 同じ組の 1 時間の鍵をためる長さ (50 分) */
export const TOKEN_KEEP_MS = 50 * 60_000;
/** 1 時間の鍵の期限の前に、ためるのを止める間 (10 分)。使う間に切れないようにする */
const TOKEN_MARGIN_MS = 10 * 60_000;
/** App の JWT の長さ。GitHub は 10 分までを受け、時計のずれのため 60 秒前から効かせる */
const APP_JWT_S = { back: 60, ahead: 540 };

/** App の権限。非公開で、workflows の権限は持たない (タスクとレビューの 3.2 の 2) */
export const APP_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", administration: "write", metadata: "read" } as const;
/** App が受ける通知の種類 (タスクとレビューの 3.5)。installation は App に必ず届く */
const APP_EVENTS = ["check_run", "check_suite", "pull_request", "pull_request_review", "issues"];

/** vault から読んだ GitHub App */
export type GitHubApp = {
  /** App ID */
  appId: number;
  /** URL に入る名前 */
  slug: string;
  /** 元の鍵 (PEM) */
  privateKey: Secret;
  /** 通知の秘密 */
  webhookSecret: Secret;
  /** vault の版 */
  version: number;
};

/** vault から読んだ連携の今 */
export type GitHubLink = {
  /** App。作っていないか、読めなければ null */
  app: GitHubApp | null;
  /** github_app のいちばん大きい版 */
  appTop: number;
  /** インストール。入れていないか、外されたら null */
  installation: { id: number; version: number } | null;
  /** github_installation のいちばん大きい版 */
  installationTop: number;
};

/**
 * vault の中身を形で確かめて読む。形が違えば null
 * @param value 中身
 * @param schema 形
 * @returns 確かめた中身
 */
function parseStored<T>(value: Secret | null, schema: ZodType<T>): T | null {
  if (value === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value.reveal()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * vault から App とインストールを読む
 * @param env バインディング
 * @returns 連携の今
 */
export async function loadLink(env: Bindings): Promise<GitHubLink> {
  const [app, installation] = await Promise.all([readStored(env.DB, "github_app", env.MASTER_KEY), readStored(env.DB, "github_installation", env.MASTER_KEY)]);
  const keys = parseStored(app.value, GitHubAppKeys);
  const inst = parseStored(installation.value, GitHubInstallationKey);
  return {
    app: keys && app.version !== null ? { appId: keys.appId, slug: keys.slug, privateKey: new Secret(keys.privateKey), webhookSecret: new Secret(keys.webhookSecret), version: app.version } : null,
    appTop: app.top,
    installation: inst && installation.version !== null ? { id: inst.id, version: installation.version } : null,
    installationTop: installation.top,
  };
}

/**
 * DER の長さを書く。X.690 の 8.1.3
 * @param n 長さ
 * @returns 長さのバイト
 */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * GitHub が渡す PKCS#1 の PEM を、WebCrypto が読む PKCS#8 の DER にする。RFC 5208 の 5 章
 * @param pem 秘密鍵の PEM
 * @returns PKCS#8 の DER
 * @throws internal PEM の形が違う時
 */
export function pkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem);
  const der = match ? fromBase64((match[2] ?? "").replace(/\s+/g, "")) : null;
  if (!match || !der) throw new AppError("internal", "App の鍵の形が違う");
  if (match[1] === undefined) return der;
  // AlgorithmIdentifier の rsaEncryption (1.2.840.113549.1.1.1) と NULL
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const body = [0x02, 0x01, 0x00, ...algorithm, 0x04, ...derLength(der.length), ...der];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

/**
 * App の元の鍵で、App として GitHub を呼ぶ JWT を作る。RS256 だけを使う
 * @param app App
 * @param now 今の時刻
 * @returns App の JWT
 */
export async function appJwt(app: Pick<GitHubApp, "appId" | "privateKey">, now: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8Der(app.privateKey.reveal()), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const at = Math.floor(now / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "RS256", typ: "JWT" }).setIssuer(String(app.appId)).setIssuedAt(at - APP_JWT_S.back).setExpirationTime(at + APP_JWT_S.ahead).sign(key);
}

/**
 * GitHub の REST API を呼ぶ。決めた宛先の下だけに出す
 * @param env バインディング
 * @param fetcher 外への fetch
 * @param path 宛先より後ろの道
 * @param init 要求
 * @returns 返事
 * @throws upstream_failed 届かない時
 */
export async function callGitHub(env: Bindings, fetcher: Fetcher, path: string, init: RequestInit): Promise<Response> {
  const root = `${endpoints(env).github.replace(/\/$/, "")}/`;
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...Object.fromEntries(new Headers(init.headers).entries()) };
  try {
    return await allowedFetch(fetcher, `${root}${path}`, [root], { ...init, headers });
  } catch {
    throw new AppError("upstream_failed", "GitHub に届かない");
  }
}

/**
 * 返事の本文を形で確かめる
 * @param res 返事
 * @param schema 形
 * @returns 確かめた本文
 * @throws upstream_failed 形が違う時
 */
export async function parseGitHub<T>(res: Response, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new AppError("upstream_failed", "GitHub の返事の形が違う");
  return parsed.data;
}

/**
 * GitHub App の manifest を作る。戻り先と通知の先は要求の origin の下に置く
 * @param origin 公開の origin
 * @returns manifest
 */
export function appManifest(origin: string): Record<string, unknown> {
  // App の名前は GitHub の全体で 1 つしか使えないので、乱数を足す
  const suffix = toBase64url(crypto.getRandomValues(new Uint8Array(4))).toLowerCase().replace(/[^a-z0-9]/g, "0");
  return {
    name: `know-office-${suffix}`,
    url: origin,
    hook_attributes: { url: `${origin}/hooks/v1/github`, active: true },
    redirect_url: `${origin}/api/v1/github/callback`,
    setup_url: `${origin}/api/v1/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

/** state の署名に付ける頭。ログインセッションのクッキーの署名と取り違えない */
const STATE_CONTEXT = "know-office:github-state:";

/** state の中身。exp は期限、n は使い捨ての値 */
const StatePayload = z.object({ exp: z.number(), n: z.string().regex(/^[A-Za-z0-9_-]{22}$/) });

/**
 * 10 分効く state を、ログインセッションの署名の鍵で作る
 * @param env バインディング
 * @param clock 時刻
 * @returns state
 */
export async function signState(env: Bindings, clock: Clock): Promise<string> {
  const key = await signingKey(await vaultKey(env.DB, "session_signing", env.MASTER_KEY, clock));
  const now = clock.now();
  const nonce = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  // 使い捨ての値を D1 に置き、callback で 1 度だけ消せるようにする。切れた値はここで掃く
  await env.DB.batch([
    env.DB.prepare("DELETE FROM github_states WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO github_states (nonce, created_at, expires_at) VALUES (?, ?, ?)").bind(nonce, now, now + STATE_MS),
  ]);
  const payload = toBase64url(new TextEncoder().encode(JSON.stringify({ exp: now + STATE_MS, n: nonce })));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${STATE_CONTEXT}${payload}`));
  return `${payload}.${toBase64url(signature)}`;
}

/**
 * state の署名と期限を確かめ、使い捨ての値を 1 文で消す。消せた時だけ進める
 * @param env バインディング
 * @param clock 時刻
 * @param state 戻ってきた state。形は呼ぶ側が確かめている
 * @throws forbidden 署名が合わない、期限を過ぎた、もう使った時
 */
export async function consumeState(env: Bindings, clock: Clock, state: string): Promise<void> {
  const [payload = "", encoded = ""] = state.split(".");
  const signature = fromBase64url(encoded);
  const key = await signingKey(await vaultKey(env.DB, "session_signing", env.MASTER_KEY, clock));
  // HMAC の verify は時間が一定の比べ方をする。API の決まりの 3.6 の 3
  const valid = signature !== null && (await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(`${STATE_CONTEXT}${payload}`)).catch(() => false));
  if (!valid) throw new AppError("forbidden", "state が一致しない");
  const bytes = fromBase64url(payload);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
  } catch {
    parsed = null;
  }
  const body = StatePayload.safeParse(parsed);
  const now = clock.now();
  if (!body.success || body.data.exp <= now) throw new AppError("forbidden", "state の期限を過ぎた");
  // 同じ state で 2 度進めないよう、読んで確かめず消せた件数で決める
  const used = await env.DB.prepare("DELETE FROM github_states WHERE nonce = ? AND expires_at > ?").bind(body.data.n, now).run();
  if (used.meta.changes === 0) throw new AppError("forbidden", "state はもう使った");
}

/**
 * manifest の code を App の元の鍵に替える。code は 1 度だけ使える
 * @param env バインディング
 * @param fetcher 外への fetch
 * @param code GitHub が戻した code。形は呼ぶ側が確かめている
 * @returns App ID、名前、元の鍵、通知の秘密
 * @throws upstream_failed GitHub が失敗を返した時、返事の形が違う時
 */
export async function exchangeCode(env: Bindings, fetcher: Fetcher, code: string) {
  const res = await callGitHub(env, fetcher, `app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  return parseGitHub(res, GitHubAppConversion);
}

/**
 * インストールが自分の App の物かを GitHub に聞く
 * @param env バインディング
 * @param fetcher 外への fetch
 * @param app 自分の App
 * @param installationId インストール ID
 * @param now 今の時刻
 * @throws forbidden 自分の App のインストールでない時
 * @throws upstream_failed GitHub が失敗を返した時
 */
export async function checkInstallation(env: Bindings, fetcher: Fetcher, app: GitHubApp, installationId: number, now: number): Promise<void> {
  const res = await callGitHub(env, fetcher, `app/installations/${String(installationId)}`, { headers: { authorization: `Bearer ${await appJwt(app, now)}` } });
  // GitHub はほかの App のインストールを 404 で隠す
  if (res.status === 404) throw new AppError("forbidden", "自分の App のインストールではない");
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  const found = await parseGitHub(res, GitHubInstallation);
  if (found.app_id !== app.appId || found.id !== installationId) throw new AppError("forbidden", "自分の App のインストールではない");
}

/**
 * インストールを外した事にする。まだ使える版の時だけ、インストールと App の鍵を 1 回の batch で取り消し、取り消せた時だけ監査ログに残す。もう一度つなぐ時は新しい App を作る
 * @param env バインディング
 * @param installation 外れたインストール
 * @param installation.id インストール ID
 * @param installation.version vault の版
 * @param app 外れたインストールの App
 * @param app.version vault の版
 * @param now 今の時刻
 * @param why 気づいたきっかけ
 * @returns 取り消せたら true
 */
export async function dropInstallation(env: Bindings, installation: { id: number; version: number }, app: { version: number }, now: number, why: "webhook" | "token_404"): Promise<boolean> {
  const [result] = await env.DB.batch([revokeStatement(env.DB, "github_installation", installation.version, now), revokeStatement(env.DB, "github_app", app.version, now)]);
  if ((result?.meta.changes ?? 0) === 0) return false;
  await auditFrom(env, { at: now, actor: "system", action: "github.uninstalled", target: String(installation.id), scope: "office", detail: { why } });
  return true;
}

/** 1 時間の鍵をためる所。同じ App、インストール、リポジトリ、権限の組に 1 つ */
export class TokenCache {
  readonly #entries = new Map<string, { token: Secret; until: number }>();

  /**
   * ためた鍵を返す
   * @param key 組
   * @param now 今の時刻
   * @returns 鍵。無いか、ためる長さを過ぎたら null
   */
  get(key: string, now: number): Secret | null {
    const found = this.#entries.get(key);
    if (!found) return null;
    if (found.until <= now) {
      this.#entries.delete(key);
      return null;
    }
    return found.token;
  }

  /**
   * 鍵をためる
   * @param key 組
   * @param token 鍵
   * @param until ためる期限
   */
  put(key: string, token: Secret, until: number): void {
    this.#entries.set(key, { token, until });
  }

  /**
   * ためた鍵の数
   * @returns 数
   */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * ためた鍵をすべて取り出し、ためる所を空にする
   * @returns 取り出した鍵
   */
  drain(): Secret[] {
    const tokens = [...this.#entries.values()].map((e) => e.token);
    this.#entries.clear();
    return tokens;
  }
}

/**
 * ためた 1 時間の鍵を GitHub の側で取り消し、ためる所を空にする。全体を止めた時に呼ぶ (自動停止の 3.5)
 * 取り消しに失敗した鍵も捨てる。元の鍵は vault で取り替えるので、新しい鍵は作れない
 * @param env バインディング
 * @param deps fetch とためる所
 * @param deps.fetcher 外への fetch
 * @param deps.cache ためる所
 */
export async function revokeTokens(env: Bindings, deps: { fetcher: Fetcher; cache: TokenCache }): Promise<void> {
  const tokens = deps.cache.drain();
  await Promise.all(
    tokens.map((token) => callGitHub(env, deps.fetcher, "installation/token", { method: "DELETE", headers: { authorization: `Bearer ${token.reveal()}` } }).catch(() => null)),
  );
}

/** Worker の中で共にためる所。要求ごとに作る受け手も同じ所を使う */
export const SHARED_TOKENS = new TokenCache();

/** 1 時間の鍵を作るのに使う物 */
export type TokenDeps = {
  /** 外への fetch */
  fetcher: Fetcher;
  /** 時刻 */
  clock: Clock;
  /** ためる所 */
  cache: TokenCache;
};

/**
 * 返った鍵が頼んだ通りに絞られているかを見る。広い鍵は使わない
 * @param got 返事
 * @param repo 頼んだリポジトリ
 * @param permissions 頼んだ権限
 * @returns 頼んだ通りなら true
 */
function narrowed(got: z.infer<typeof GitHubAccessToken>, repo: string | null, permissions: Permissions): boolean {
  if (repo !== null && (got.repositories?.length !== 1 || got.repositories[0]?.full_name !== repo)) return false;
  // GitHub は metadata の読みを必ず付ける
  const wanted = new Map<string, string>(Object.entries(permissions));
  const extra = Object.entries(got.permissions).filter(([name, level]) => wanted.get(name) !== level && !(name === "metadata" && level === "read"));
  const missing = Object.entries(permissions).filter(([name, level]) => got.permissions[name] !== level);
  return extra.length === 0 && missing.length === 0;
}

/**
 * リポジトリ 1 つと要る権限だけに絞った 1 時間の鍵を作る。同じ組の鍵は 50 分ためる
 * @param env バインディング
 * @param deps fetch、時刻、ためる所
 * @param repo リポジトリ。null はインストールで選んだすべて (一覧を読む時だけ)
 * @param permissions 要る権限
 * @returns 鍵
 * @throws upstream_failed つないでいない、外された、GitHub が失敗を返した、返った鍵が広い時
 * @throws rule_denied インストールで選んでいないリポジトリの時
 */
export async function githubToken(env: Bindings, deps: TokenDeps, repo: string | null, permissions: Permissions): Promise<Secret> {
  if (repo !== null && !RepoName.safeParse(repo).success) throw new AppError("upstream_failed", "リポジトリの名前の形が違う");
  const link = await loadLink(env);
  if (!link.app || !link.installation) throw new AppError("upstream_failed", "GitHub とまだつないでいない");
  const now = deps.clock.now();
  const key = canonicalJson([link.app.version, link.installation.id, link.installation.version, repo, permissions]);
  const kept = deps.cache.get(key, now);
  if (kept) return kept;
  const request = { permissions, ...(repo === null ? {} : { repositories: [repo.split("/")[1] ?? ""] }) };
  const res = await callGitHub(env, deps.fetcher, `app/installations/${String(link.installation.id)}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${await appJwt(link.app, now)}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (res.status === 404) {
    // App を外した通知が届かなくても、ここで連携を切る (タスクとレビューの 3.2 の 5)
    await dropInstallation(env, link.installation, link.app, now, "token_404");
    throw new AppError("upstream_failed", "GitHub App が外された");
  }
  if (res.status === 422 && repo !== null) throw new AppError("rule_denied", "連携で選んでいないリポジトリ");
  if (!res.ok) throw new AppError("upstream_failed", `GitHub が ${String(res.status)} を返した`);
  const got = await parseGitHub(res, GitHubAccessToken);
  if (!narrowed(got, repo, permissions)) throw new AppError("upstream_failed", "GitHub が頼んだより広い鍵を返した");
  const token = new Secret(got.token);
  deps.cache.put(key, token, Math.min(now + TOKEN_KEEP_MS, Date.parse(got.expires_at) - TOKEN_MARGIN_MS));
  return token;
}

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
    loaded ??= loadLink(env).then((link) => (link.app && link.installation ? httpForge(endpoints(env).github, deps.fetcher, vaultAccess(env, deps, link.app.appId)) : UNCONNECTED_FORGE));
    return loaded;
  };
  return {
    openPull: async (input) => (await load()).openPull(input),
    checksPassed: async (repo, pr) => (await load()).checksPassed(repo, pr),
    merge: async (repo, branch) => (await load()).merge(repo, branch),
    changedPaths: async (repo, branch) => (await load()).changedPaths(repo, branch),
    protectMain: async (repo, when) => (await load()).protectMain(repo, when),
    connected: async () => (await load()).connected(),
  };
}
