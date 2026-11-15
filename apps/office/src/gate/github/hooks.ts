// GitHub の通知の受け手。署名、時刻、本文の SHA-256 を確かめ、チェック、プルリクエスト、Issue、App を外した事を受ける (タスクとレビューの 3.5)
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { AppError, CheckRunEvent, CheckSuiteEvent, DeliveryId, GitHubEventName, GitHubWebhookHead, HubSignature, IssuesEvent, PullRequestEvent } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { services } from "../db/main.ts";
import type { Bindings, GateEnv } from "../env.ts";
import { guardOf } from "../auth/middleware.ts";
import { auditFrom } from "../ledger/record.ts";
import { intakeTask } from "../work/loop.ts";
import { type GitHubLink, loadLink } from "./app.ts";
import { repoScope } from "./rules.ts";

/** 受ける本文の上限 (5MB)。GitHub の通知の上限に合わせる */
export const HOOK_BODY_BYTES = 5 * 1024 * 1024;
/** 受ける通知の時刻の幅 (5 分)。これより古い通知と先の通知は捨てる */
export const HOOK_WINDOW_MS = 5 * 60_000;
/** チェックが通ったとみる結果 */
const PASSED = new Set(["success", "neutral", "skipped"]);
/** UUID 版 1 の時刻の起点 (1582-10-15) から 1970-01-01 までの 100 ナノ秒の数。RFC 9562 の 5.1 */
const GREGORIAN_OFFSET = 0x01b21dd213814000n;

/**
 * 本文を上限まで読む
 * @param stream 本文
 * @param limit 上限のバイト数
 * @returns 本文。上限を超えたら null
 */
async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * 16 進数をバイト列にする
 * @param hex 形を確かめた 16 進数
 * @returns バイト列
 */
function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

/**
 * 配信 ID が UUID 版 1 なら時刻を読む
 * @param id 形を確かめた配信 ID
 * @returns 協定世界時のミリ秒。版 1 でなければ null
 */
export function deliveryTime(id: string): number | null {
  const [low = "", mid = "", high = ""] = id.toLowerCase().split("-");
  if (!high.startsWith("1")) return null;
  const ticks = (BigInt(`0x${high.slice(1)}`) << 48n) | (BigInt(`0x${mid}`) << 32n) | BigInt(`0x${low}`);
  return Number((ticks - GREGORIAN_OFFSET) / 10_000n);
}

/**
 * 通知を確かめて受ける。捨てる通知も、受けた事として 204 を返せるよう投げずに戻る
 * @param c 要求の文脈
 * @throws payload_too_large 本文が 5MB を超える時
 * @throws unauthenticated 連携していない、署名が無い、合わない時
 * @throws rate_limited 署名の合った通知が 1 分に 60 回を超えた時
 * @throws malformed_request 配信 ID、種類、本文の形が違う時
 */
export async function receiveHook(c: Context<GateEnv>): Promise<void> {
  if (Number(c.req.header("Content-Length") ?? "0") > HOOK_BODY_BYTES) throw new AppError("payload_too_large", "本文が 5MB を超える");
  const signature = HubSignature.safeParse(c.req.header("X-Hub-Signature-256"));
  if (!signature.success) throw new AppError("unauthenticated", "署名が無い");
  const raw = await readLimited(c.req.raw.body, HOOK_BODY_BYTES);
  if (!raw) throw new AppError("payload_too_large", "本文が 5MB を超える");
  const link = await loadLink(c.env);
  if (!link.app) throw new AppError("unauthenticated", "GitHub とまだつないでいない");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(link.app.webhookSecret.reveal()), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // HMAC の verify は時間が一定の比べ方をする。API の決まりの 3.6 の 3
  if (!(await crypto.subtle.verify("HMAC", key, hexBytes(signature.data.slice("sha256=".length)), raw))) throw new AppError("unauthenticated", "署名が合わない");
  const now = c.var.clock.now();
  // 通知の全体の数は署名の合った物だけで数え、署名の無い要求で本物の通知を締め出させない
  const { retryAfter } = await guardOf(c).admit("hooks:github", "hook", now);
  if (retryAfter !== null) throw new AppError("rate_limited", "通知が多すぎる", { headers: { "Retry-After": String(retryAfter) } });
  const delivery = DeliveryId.safeParse(c.req.header("X-GitHub-Delivery"));
  const event = GitHubEventName.safeParse(c.req.header("X-GitHub-Event"));
  if (!delivery.success || !event.success) throw new AppError("malformed_request", "配信 ID か種類の形が違う");
  // 時刻の入った配信 ID なら、時刻の外は捨てる。送り直しは配信 ID が変わるので、2 度受けないのは本文の SHA-256 で決める
  const sent = deliveryTime(delivery.data);
  if (sent !== null && Math.abs(now - sent) > HOOK_WINDOW_MS) return;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), (b) => b.toString(16).padStart(2, "0")).join("");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new AppError("malformed_request", "本文が JSON でない");
  }
  const head = GitHubWebhookHead.safeParse(payload);
  if (!head.success) throw new AppError("malformed_request", "本文の形が違う");
  // ほかのインストールの通知は知らない物として捨てる
  if (!link.installation || head.data.installation?.id !== link.installation.id) return;
  await handle(c.env, { delivery: delivery.data, digest, event: event.data, action: head.data.action ?? null, repo: head.data.repository?.full_name ?? null, payload, link, now });
}

/** 確かめた通知 */
type Hook = {
  delivery: string;
  /** 本文の SHA-256 (16 進数) */
  digest: string;
  event: string;
  action: string | null;
  repo: string | null;
  payload: unknown;
  link: GitHubLink;
  now: number;
};

/** 同じ本文の通知をまだ受けていない時だけ書く条件。重ねて届いた通知と送り直しは何もしない */
const FRESH = "NOT EXISTS (SELECT 1 FROM github_deliveries WHERE body_sha256 = ?)";

/**
 * 種類ごとに直す文と受けた記録を 1 回の batch で書く。Issue だけは記録を先に取ってからタスクを足す
 * @param env バインディング
 * @param hook 確かめた通知
 */
async function handle(env: Bindings, hook: Hook): Promise<void> {
  const db = env.DB;
  const record = db.prepare("INSERT OR IGNORE INTO github_deliveries (delivery_id, body_sha256, event, received_at) VALUES (?, ?, ?, ?)").bind(hook.delivery, hook.digest, hook.event, hook.now);
  if (hook.event === "issues") {
    await intakeIssue(env, hook, record);
    return;
  }
  const effects = changes(env, hook);
  const results = await db.batch([...effects, record]);
  // App を外した通知は、取り消せた時だけ記録に残す
  if (hook.event === "installation" && effects.length > 0 && (results[0]?.meta.changes ?? 0) > 0) {
    await auditFrom(env, { at: hook.now, actor: "system", action: "github.uninstalled", target: String(hook.link.installation?.id ?? ""), scope: "office", detail: { why: "webhook" } });
  }
}

/**
 * 通知で直す文を作る。どれも同じ本文をまだ受けていない時だけ書く
 * @param env バインディング
 * @param hook 確かめた通知
 * @returns 直す文
 */
function changes(env: Bindings, hook: Hook): D1PreparedStatement[] {
  const db = env.DB;
  if (hook.event === "check_run" && hook.repo !== null) {
    const run = CheckRunEvent.safeParse(hook.payload);
    if (!run.success) return [];
    const { name, status, conclusion, head_sha: sha } = run.data.check_run;
    const ok = status === "completed" && conclusion !== null && PASSED.has(conclusion);
    // 同じ名前の結果を置き換え、名前の順に並べる。読んで書き直さず 1 文で直し、同時に届いた 2 つの片方を消さない
    return [
      db
        .prepare(
          `UPDATE reviews SET checks = (SELECT json_group_array(json(v)) FROM (SELECT v FROM (SELECT value AS v FROM json_each(COALESCE(reviews.checks, '[]')) WHERE json_extract(value, '$.name') <> ? UNION ALL SELECT json_object('name', ?, 'ok', json(?)) AS v) ORDER BY json_extract(v, '$.name'))) WHERE repo = ? AND head_sha = ? AND ${FRESH}`,
        )
        .bind(name, name, ok ? "true" : "false", hook.repo, sha, hook.digest),
    ];
  }
  if (hook.event === "check_suite" && hook.repo !== null && (hook.action === "requested" || hook.action === "rerequested")) {
    const suite = CheckSuiteEvent.safeParse(hook.payload);
    if (!suite.success) return [];
    return [db.prepare(`UPDATE reviews SET checks = '[]' WHERE repo = ? AND head_sha = ? AND ${FRESH}`).bind(hook.repo, suite.data.check_suite.head_sha, hook.digest)];
  }
  if (hook.event === "pull_request" && hook.repo !== null && hook.action === "synchronize") {
    const pull = PullRequestEvent.safeParse(hook.payload);
    if (!pull.success) return [];
    const { number, head } = pull.data.pull_request;
    return [db.prepare(`UPDATE reviews SET head_sha = ?, checks = '[]' WHERE repo = ? AND pr_number = ? AND ${FRESH}`).bind(head.sha, hook.repo, number, hook.digest)];
  }
  const { installation, app } = hook.link;
  if (hook.event === "installation" && installation && app && (hook.action === "deleted" || hook.action === "suspend")) {
    // 外された App の元の鍵も取り消し、もう一度つなぐ時は新しい App を作る
    const revoke = (name: string, version: number) =>
      db.prepare(`UPDATE vault SET revoked_at = ? WHERE name = ? AND version = ? AND revoked_at IS NULL AND ${FRESH}`).bind(hook.now, name, version, hook.digest);
    return [revoke("github_installation", installation.version), revoke("github_app", app.version)];
  }
  return [];
}

/**
 * 選んだリポジトリで開いた Issue を、社長の plan のタスクにする (タスクとレビューの 3.1 の 6)
 * 受けた記録を先に 1 文で取り、取れた側だけがタスクを足す。足せなければ記録を消し、GitHub の送り直しで受け直す
 * @param env バインディング
 * @param hook 確かめた通知
 * @param record 受けた記録を書く文
 */
async function intakeIssue(env: Bindings, hook: Hook, record: D1PreparedStatement): Promise<void> {
  const issue = IssuesEvent.safeParse(hook.payload);
  const relevant = hook.action === "opened" && hook.repo !== null && issue.success && issue.data.issue.pull_request === undefined && issue.data.sender?.type !== "Bot";
  if (!relevant || hook.repo === null || !issue.success) {
    await record.run();
    return;
  }
  const repo = hook.repo;
  const scope = await repoScope(env.DB, repo);
  if (scope.repos !== null && !scope.repos.includes(repo)) {
    await record.run();
    return;
  }
  const taken = await record.run();
  if (taken.meta.changes === 0) return;
  try {
    const [owner] = await drizzle(env.DB).select({ id: services.id }).from(services).where(eq(services.repo, repo)).orderBy(services.id).limit(1);
    const { number, title, body } = issue.data.issue;
    await intakeTask(env, { scope: owner?.id ?? "office", title, body: body ?? "", source: "issue", issueNumber: number }, hook.now);
  } catch (error) {
    await env.DB.prepare("DELETE FROM github_deliveries WHERE body_sha256 = ?").bind(hook.digest).run();
    throw error;
  }
}
