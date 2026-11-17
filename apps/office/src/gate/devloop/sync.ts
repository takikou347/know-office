// 設計書のリポジトリの push を受け、設計書が変わったサービスの Issue を合わせるタスクを社長に足す (開発の回し方の 3.3)
import { GitHubPushEvent, parseRequirements, SERVICE_NAME } from "@know-office/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { devIssues, nodes, services } from "../db/main.ts";
import { insertedWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { intakeProject, newNodeRow, recordCreated } from "../work/nodes.ts";
import { type Forge, notifyStaff } from "../work/loop.ts";

/** Issue を合わせるのは、この段階のサービスだけ */
const STAGES = ["prototype", "service", "operation"] as const;

/**
 * 1 回の合わせるタスクのために読む、詳細設計の機能のファイルの上限。Workers の 1 回の要求の外への呼び出しの上限 (有料は 10,000、Cloudflare Workers の Limits) に、鍵の取得などの分を残す
 * 1 サービスの内訳は、木 1、中身の読み 60 の 61 回。変えた道が分からない push は試作から運用までの全サービスを回るので、サービスが 160 を超えると 10,000 に届く。届く前に上限を見直す
 */
export const SYNC_READ_MAX = 60;

/** push の通知が並べる commits の件数がこれに届いたら、変えた道を全部は知らないとみる。GitHub は 1 回の push の commits を 20 件までしか並べなかった時期があり、届いた数は切られた印として扱う */
export const COMMITS_CUT = 20;

/** 詳細設計の機能のファイルの道 */
const FEATURE = /^(\d+-[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/**
 * push で変わった設計書の置き場から、サービスの名前を重ねずに返す。`services/<名前>/docs/04-detail/` か `01-overview/` の下だけを見る
 * @param push push の通知
 * @returns サービスの名前。commits が切られているかを tooMany で返す
 */
function touchedNames(push: ReturnType<typeof GitHubPushEvent.parse>): { names: Set<string>; unknown: boolean } {
  const commits = push.commits ?? [];
  const names = new Set<string>();
  for (const commit of commits) {
    for (const path of [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])]) {
      const m = /^services\/([^/]+)\/docs\/(?:04-detail|01-overview)\//.exec(path);
      if (m?.[1] !== undefined) names.add(m[1]);
    }
  }
  return { names, unknown: commits.length >= COMMITS_CUT };
}

/**
 * 今の設計書と dev_issues を比べた、足した要件、本文が変わった要件、消えた要件の一覧を作る。一覧は参考で、issue_plan が今のコミットで確かめる
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param input 設計書のリポジトリ、コミット、サービス
 * @param input.docs 設計書のリポジトリ
 * @param input.sha 比べるコミット
 * @param input.name サービスの置き場の名前
 * @param input.serviceId サービス ID
 * @returns タスクの本文に足す行
 * @throws upstream_failed GitHub から読めない時
 */
async function compareLines(env: Bindings, forge: Forge, input: { docs: string; sha: string; name: string; serviceId: string }): Promise<string[]> {
  const prefix = `services/${input.name}/docs/04-detail/`;
  const listed = await forge.listFiles(input.docs, input.sha, prefix);
  if (listed === null) return ["設計書の木を読み切れないので、一覧は付けられない"];
  const files = listed.flatMap((p) => {
    const m = FEATURE.exec(p.slice(prefix.length));
    return m?.[1] === undefined ? [] : [{ path: p, feature: m[1] }];
  });
  const rows = await drizzle(env.DB).select().from(devIssues).where(and(eq(devIssues.serviceId, input.serviceId), eq(devIssues.kind, "child"), inArray(devIssues.state, ["open", "closed"])));
  const added: string[] = [];
  const changed: string[] = [];
  const seen = new Set<string>();
  const read = files.slice(0, SYNC_READ_MAX);
  for (const file of read) {
    const text = await forge.readFile(input.docs, input.sha, file.path);
    if (text === null) continue;
    for (const req of await parseRequirements(text)) {
      seen.add(`${file.feature}\n${req.name}`);
      const mine = rows.filter((r) => r.feature === file.feature && r.requirement === req.name);
      if (mine.length === 0) added.push(`${file.feature} ${req.name}`);
      else if (!mine.some((r) => r.reqHash === req.hash)) changed.push(`${file.feature} ${req.name}`);
    }
  }
  // 読み切れなかった機能のファイルの分は、消えたと言えない
  const complete = files.length <= SYNC_READ_MAX;
  const gone = complete ? rows.filter((r) => r.state === "open" && !seen.has(`${r.feature}\n${r.requirement ?? ""}`)).map((r) => `${r.feature} ${r.requirement ?? ""}`) : [];
  return [
    `足した要件: ${added.join("、") || "なし"}`,
    `本文が変わった要件: ${changed.join("、") || "なし"}`,
    `消えた要件: ${complete ? gone.join("、") || "なし" : "読み切れないので分からない"}`,
    ...(complete ? [] : [`機能のファイルが ${String(files.length)} 件あり、${String(SYNC_READ_MAX)} 件までしか読んでいない。読み切れない`]),
  ];
}

/**
 * 設計書のリポジトリの既定のブランチへの push を受け、設計書が変わったサービスの社長に Issue を合わせるタスクを足す
 * `services/<名前>/docs/04-detail/` か `01-overview/` が変わり、その名前のサービスが試作、サービス、運用のどれかで、同じサービスの合わせるタスクが todo に無い時だけ足す (1 文)。doing の間は次の 1 つを足す
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param payload 通知の本文
 * @param now 今の時刻
 * @throws upstream_failed GitHub から読めない時。呼んだ側が受けた記録を消し、送り直しで受け直す
 */
export async function receiveDocsPush(env: Bindings, forge: Forge, payload: unknown, now: number): Promise<void> {
  const parsed = GitHubPushEvent.safeParse(payload);
  if (!parsed.success) return;
  const push = parsed.data;
  // 既定のブランチへの push だけ。ref と repository.default_branch で見る
  if (push.ref !== `refs/heads/${push.repository.default_branch}`) return;
  const { names, unknown } = touchedNames(push);
  if (names.size === 0 && !unknown) return;
  const orm = drizzle(env.DB);
  const candidates = await orm.select().from(services).where(inArray(services.stage, [...STAGES]));
  const actor = { by: "system", now } as const;
  for (const service of candidates) {
    const name = (service.repo?.split("/")[1] ?? "").toLowerCase();
    if (!SERVICE_NAME.test(name) || (!unknown && !names.has(name))) continue;
    const source = `issue-sync:${service.id}`;
    // 比べるのは足す前。読めなければ投げて、足さずに送り直しを待つ
    const lines = await compareLines(env, forge, { docs: push.repository.full_name, sha: push.after, name, serviceId: service.id });
    const project = await intakeProject(env, service.id, actor);
    const task = await newNodeRow(
      env,
      {
        kind: "task",
        parentId: project.id,
        scope: service.id,
        title: `Issue を合わせる: ${service.name}`,
        body: [
          `サービス ID: ${service.id}`,
          `設計書: ${push.repository.full_name} の services/${name}/ (コミット ${push.after})`,
          ...lines,
          "この一覧は参考で、issue_plan が今のコミットで確かめる。詳細設計の機能のファイルごとに、親と子の組を issue_plan で送る",
        ].join("\n"),
        taskKind: "plan",
        assignee: "president",
        source,
      },
      actor,
    );
    // 重なりは todo だけで止める。doing の間の push は、次の 1 つが足される
    const none = sql`NOT EXISTS (SELECT 1 FROM ${nodes} WHERE ${nodes.source} = ${source} AND ${nodes.status} = 'todo')`;
    if (await insertedWhen(env.DB, nodes, task, none)) {
      await recordCreated(env, task, actor);
      await notifyStaff(env, "president", now, false);
    }
  }
}
