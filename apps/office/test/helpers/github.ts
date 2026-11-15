// GitHub の連携のテストの手伝い。代わりの GitHub の画面で App を作って入れ、通知を送り、ワークスペースから git を呼ぶ (タスクとレビューの 3.2 から 3.5)
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import type { StaffId } from "@know-office/core";
import { expect } from "vitest";
import { z } from "zod";
import { deliveryId, sendWebhook } from "../../dev/github-hooks.ts";
import { type Caller, routeEgress } from "../../src/gate/egress.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { MINUTE, type WorkWorld } from "./work.ts";

/** 代わりの物の置き場。test/helpers/gate.ts と同じ */
export const FAKES = "http://localhost:5199";

/** 連携した結果 */
export type Connected = {
  /** App ID */
  appId: number;
  /** インストール ID */
  installationId: number;
  /** 通知の秘密 */
  webhookSecret: string;
};

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
export async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * ログインしたブラウザーと同じヘッダーで、ゲートウェイに GET を出す
 * @param w テストの物
 * @param url 道か、http://localhost の URL
 * @param headers ヘッダー。無ければログインしたブラウザーの物
 * @returns 返事
 */
export function browse(w: WorkWorld, url: string, headers: Record<string, string> = w.headers): Promise<Response> {
  const u = new URL(url, "http://localhost");
  return w.gate.request(`${u.pathname}${u.search}`, { headers });
}

/**
 * GitHub が戻すブラウザーと同じく、ログインセッションのクッキーを付けずに GET を出す。クッキーは SameSite=Strict なので、github.com から戻る時には付かない
 * @param w テストの物
 * @param url 道か、http://localhost の URL
 * @returns 返事
 */
export function returnFromGitHub(w: WorkWorld, url: string): Promise<Response> {
  const { Cookie: _cookie, ...rest } = w.headers;
  return browse(w, url, rest);
}

/**
 * 代わりの GitHub の画面に要求を出す
 * @param w テストの物
 * @param url 代わりの物の URL
 * @param init 要求
 * @returns 返事
 */
export function onGitHub(w: WorkWorld, url: string, init?: RequestInit): Promise<Response> {
  expect(url.startsWith(`${FAKES}/github/`)).toBe(true);
  return Promise.resolve(w.gate.github.app.request(url.slice(`${FAKES}/github`.length), init));
}

/**
 * 連携のボタンを押し、返った manifest を GitHub の画面へ送って「作成」を押す
 * @param w テストの物
 * @returns GitHub が戻す callback の URL
 */
export async function createGitHubApp(w: WorkWorld): Promise<string> {
  const res = await w.gate.request("/api/v1/github/connect", { method: "POST", headers: w.headers });
  expect(res.status).toBe(200);
  const { action, manifest } = z.object({ data: z.object({ action: z.string(), manifest: z.unknown(), state: z.string() }) }).parse(await res.json()).data;
  const made = await onGitHub(w, action, { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(manifest) }) });
  expect(made.status).toBe(302);
  return made.headers.get("location") ?? "";
}

/**
 * 連携のボタンから、GitHub の画面で「作成」と「インストール」を押すまでを通す
 * @param w テストの物
 * @returns App ID、インストール ID、通知の秘密
 */
export async function connect(w: WorkWorld): Promise<Connected> {
  await stepUp(w);
  const callback = await createGitHubApp(w);
  const toInstall = await returnFromGitHub(w, callback);
  expect(toInstall.status).toBe(302);
  const installed = await onGitHub(w, toInstall.headers.get("location") ?? "");
  const setup = installed.headers.get("location") ?? "";
  const done = await returnFromGitHub(w, setup);
  expect(done.status).toBe(302);
  const app = [...w.gate.github.apps.values()].at(-1);
  if (!app) throw new Error("App ができていない");
  return { appId: app.id, installationId: Number(new URL(setup).searchParams.get("installation_id")), webhookSecret: app.webhookSecret };
}

/**
 * ゲートウェイの D1 の prepare と batch を包む。手元の D1 は代わりの物の中にあり、メソッドを差し替えられないので、包んだ物を env に置く
 * @param w テストの物
 * @param wrap 包む prepare か batch。元の物を受ける
 * @param wrap.prepare 包む prepare
 * @param wrap.batch 包む batch
 * @returns 元に戻す関数
 */
export function wrapDb(
  w: WorkWorld,
  wrap: { prepare?: (real: D1Database["prepare"], sql: string) => D1PreparedStatement; batch?: (real: D1Database["batch"], statements: D1PreparedStatement[]) => Promise<D1Result[]> },
): () => void {
  const real = w.gate.env.DB;
  const prepare = real.prepare.bind(real);
  const batch = real.batch.bind(real);
  const wrapped = {
    prepare: (sql: string) => (wrap.prepare ? wrap.prepare(prepare, sql) : prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => (wrap.batch ? wrap.batch(batch, statements) : batch(statements)),
    exec: (query: string) => real.exec(query),
    dump: () => real.dump(),
    withSession: (constraint?: string) => real.withSession(constraint),
  };
  // D1 のうち、ゲートウェイの使うメソッドだけを持つ包み
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  w.gate.env.DB = wrapped as unknown as D1Database;
  return () => {
    w.gate.env.DB = real;
  };
}

/** 通知 1 つ */
export type Hook = {
  /** X-GitHub-Event */
  event: string;
  /** 本文 */
  payload: unknown;
  /** 署名の鍵 */
  secret: string;
  /** X-GitHub-Delivery。無ければテストの今の時刻の配信 ID */
  delivery?: string;
};

/**
 * GitHub と同じ形の通知をゲートウェイに送る
 * @param w テストの物
 * @param sent 種類、本文、署名の鍵、配信 ID
 * @returns ゲートウェイの返事
 */
export function hook(w: WorkWorld, sent: Hook): Promise<Response> {
  return sendWebhook({
    url: "http://localhost/hooks/v1/github",
    event: sent.event,
    payload: sent.payload,
    secret: sent.secret,
    delivery: sent.delivery ?? deliveryId(w.clock.now()),
    fetcher: (req) => Promise.resolve(w.gate.app.request(req, undefined, w.gate.env)),
  });
}

/** 作業中のタスクと作業トークン */
export type Work = {
  /** 社員 ID */
  staffId: StaffId;
  /** タスク ID */
  nodeId: string;
  /** 作業トークン */
  token: string;
  /** 作業トークン ID */
  jti: string;
};

/**
 * 社員を出勤させ、リポジトリを直すタスクを持たせて作業トークンを出す
 * @param w テストの物
 * @param repo タスクのリポジトリ
 * @param staffId 社員 ID
 * @returns 社員、タスク、作業トークン
 */
export async function startTask(w: WorkWorld, repo: string, staffId: StaffId = "builder"): Promise<Work> {
  const nodeId = crypto.randomUUID();
  const { book } = w.gate.staff[staffId];
  const now = w.clock.now();
  await book.wake(now);
  await w.d1.DB.prepare(
    "INSERT INTO nodes (id, kind, parent_id, scope, title, status, priority, assignee, repo, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', '直す', 'doing', 1, ?, ?, 'president', 0, 0)",
  )
    .bind(nodeId, staffId, repo)
    .run();
  await book.take({ nodeId, title: "直す", scope: "office" }, null, now);
  const { token, jti } = await issueTicket(w.gate.env, staffId, nodeId, now);
  await book.heartbeat(now);
  return { staffId, nodeId, token, jti };
}

/**
 * ワークスペースから出る要求を、コンテナの外向きの通信の受け手に渡す
 * @param w テストの物
 * @param work 送る社員
 * @param request 要求
 * @returns 受け手の返事
 */
export function fromWorkspace(w: WorkWorld, work: Pick<Work, "staffId">, request: Request): Promise<Response> {
  const caller: Caller = { staffId: work.staffId, workspaceId: workspaceIdOf(w.gate.env, work.staffId) };
  return routeEgress(request, w.gate.env, caller, { clock: w.clock, guard: w.gate.deps, fetch: w.gate.fetch, githubTokens: w.gate.githubCache });
}

/**
 * git の push の本文を作る。ref を変える命令の pkt-line と flush の後に pack の頭を置く
 * @param updates 変える ref と、前と後の sha
 * @returns 本文
 */
export function pushBody(updates: { ref: string; from?: string; to?: string }[]): Uint8Array<ArrayBuffer> {
  const zero = "0".repeat(40);
  const lines = updates.map((u, i) => {
    const text = `${u.from ?? zero} ${u.to ?? "c".repeat(40)} ${u.ref}${i === 0 ? "\0report-status side-band-64k" : ""}\n`;
    return `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
  });
  return new TextEncoder().encode(`${lines.join("")}0000PACK\0\0\0\x02\0\0\0\0`);
}

/**
 * ワークスペースの git と同じく、作業トークンを Basic の合言葉に入れて github.com に push する
 * @param w テストの物
 * @param work 送る社員と作業トークン
 * @param repo リポジトリ
 * @param updates 変える ref
 * @returns 受け手の返事
 */
export function push(w: WorkWorld, work: Work, repo: string, updates: { ref: string; from?: string; to?: string }[]): Promise<Response> {
  return fromWorkspace(
    w,
    work,
    new Request(`https://github.com/${repo}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`x-access-token:${work.token}`)}`, "content-type": "application/x-git-receive-pack-request" },
      body: pushBody(updates),
    }),
  );
}
