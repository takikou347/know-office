// 設計書から親と子の Issue を作る。社長が送った組を今の設計書で確かめ、題と本文を決まった形で作り、sub-issue でつなぎ、子ごとに開発担当のタスクを足す (開発の回し方の 3.3、3.4)
import { AppError, devIssueKey, devIssueText, featureTitle, type IssueKind, type IssuePlanTool, isRedactedName, newId, parseRequirements, SERVICE_NAME } from "@know-office/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { devIssues, nodes } from "../db/main.ts";
import { insertedWhen, insertWhen } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { devIssueKeyOf, devIssueMark, publicDevIssues } from "../findings/tracker.ts";
import { findService } from "../services/flow.ts";
import { clockAt } from "../work/attendance.ts";
import { intakeProject, newNodeRow, type Actor, appendNodeEvent, recordCreated } from "../work/nodes.ts";
import { notifyStaff, type Forge } from "../work/loop.ts";
import { auditFrom } from "../ledger/record.ts";
import type { DevIssue } from "./dev-issues.ts";
import { loadDocsRepo } from "./docs-setting.ts";

/** pending の行を、書いた呼び出しが落ちたとみて引き取るまでの時間 (2 分)。1 回の issue_plan は書きの間を空けても 1 分に収まる */
export const PENDING_STALE_MS = 2 * 60_000;

/** 1 回の issue_plan で閉じる子の数の上限。閉じるごとにコメントと閉じるの 2 回を書くので、残りは次の issue_plan で閉じる */
export const CLOSE_MAX = 10;

/** この段階のサービスだけが Issue を持つ */
const STAGES: readonly string[] = ["prototype", "service", "operation"];

/** 閉じる理由ごとの、決まった文 */
const CLOSE_TEXT = { removed: "設計書から外れたので閉じる", replaced: "設計書の変更で置き換わったので閉じる" } as const;

/** issue_plan の答え。parents と children は番号の一覧、closed は閉じた子の番号、running は取っている作業を止めずに残した子の番号、more は閉じ切れなかった事 */
export type IssuePlanResult = {
  parents: { feature: string; number: number }[];
  children: { feature: string; requirement: string; number: number; created: boolean }[];
  closed: number[];
  running: number[];
  more: boolean;
};

type Row = typeof devIssues.$inferSelect;

/** 作る 1 件の決まり */
type Spec = {
  kind: "parent" | "child";
  feature: string;
  requirement: string | null;
  hash: string | null;
  issueKind: IssueKind | null;
  paths: string[] | null;
  high: boolean;
  title: string;
  body: string;
  key: string;
};

/**
 * 外から来た JSON の paths を文字の並びに戻す
 * @param value D1 の JSON
 * @returns 文字の並び
 */
function pathsOf(value: unknown): string[] {
  return z.array(z.string()).catch([]).parse(value);
}

/**
 * 設計書の確かめで断る時の 422 を作る
 * @param errors 直す所
 * @returns 422 の AppError
 */
function invalid(errors: { pointer: string; detail: string }[]): AppError {
  return new AppError("validation_failed", "設計書と送られた Issue の組が合わない", { errors });
}

/**
 * 親か子の 1 件を、GitHub に送る前に pending の行として取る。取れなければ今の行を返し、pending が古ければ引き取る
 * @param env バインディング
 * @param ids サービス ID とサービスのリポジトリ
 * @param ids.id サービス ID
 * @param ids.repo サービスのリポジトリ
 * @param spec 作る 1 件
 * @param now 今の時刻
 * @returns 行と、この呼び出しが GitHub に送る側か
 * @throws conflict 別の呼び出しが新しい pending の行を持っている時
 */
async function claim(env: Bindings, ids: { id: string; repo: string }, spec: Spec, now: number): Promise<{ row: Row; owned: boolean }> {
  const row: Row = {
    id: newId(clockAt(now)),
    serviceId: ids.id,
    repo: ids.repo,
    number: null,
    issueId: null,
    parentNumber: null,
    kind: spec.kind,
    feature: spec.feature,
    requirement: spec.requirement,
    reqHash: spec.hash,
    issueKind: spec.issueKind,
    paths: spec.paths,
    markKey: spec.key,
    state: "pending",
    createdAt: now,
    closedAt: null,
  };
  const same = and(eq(devIssues.serviceId, ids.id), eq(devIssues.kind, spec.kind), eq(devIssues.feature, spec.feature), spec.requirement === null ? isNull(devIssues.requirement) : eq(devIssues.requirement, spec.requirement), spec.hash === null ? isNull(devIssues.reqHash) : eq(devIssues.reqHash, spec.hash));
  // 1 文で、同じ物がまだ無い時だけ取る。同時の 2 つの呼び出しのうち取れるのは 1 つ
  const none = sql`NOT EXISTS (SELECT 1 FROM ${devIssues} WHERE ${same})`;
  if (await insertedWhen(env.DB, devIssues, row, none)) return { row, owned: true };
  const [now1] = await drizzle(env.DB).select().from(devIssues).where(same).limit(1);
  if (!now1) throw new AppError("conflict", "同じ Issue の行を取れなかった。もう一度送る");
  if (now1.state !== "pending") return { row: now1, owned: false };
  // 古い pending は、書いた呼び出しが落ちたとみて引き取る。新しければ別の呼び出しが作っている
  const taken = await drizzle(env.DB)
    .update(devIssues)
    .set({ createdAt: now })
    .where(and(eq(devIssues.id, now1.id), eq(devIssues.state, "pending"), sql`${devIssues.createdAt} < ${now - PENDING_STALE_MS}`))
    .returning({ id: devIssues.id });
  if (taken.length === 0) throw new AppError("conflict", "同じ Issue を別の呼び出しが作っている。少し待って送り直す");
  return { row: { ...now1, createdAt: now }, owned: true };
}

/**
 * 子の Issue の開発担当のタスクの本文を作る。社内のタスクなので、設計書の場所と触るファイルを書く
 * @param input 材料
 * @param input.repo サービスのリポジトリ
 * @param input.docs 設計書のリポジトリと置き場
 * @param input.spec 子の 1 件
 * @param input.number Issue の番号
 * @returns 本文
 */
function taskBody(input: { repo: string; docs: string; spec: Spec; number: number }): string {
  const { spec } = input;
  return [
    `Issue: ${input.repo}#${String(input.number)}`,
    `要件: ${spec.requirement ?? ""} (${spec.feature})`,
    `種類: ${spec.issueKind ?? "feature"}`,
    `設計書: ${input.docs}/docs/04-detail/${spec.feature}.md`,
    `触るファイル: ${pathsOf(spec.paths).join("、")}`,
    "テスト設計の同じ要件のシナリオごとに、落ちるテストから作る。済みは、シナリオが入口から画面までつながって動く事",
  ].join("\n");
}

/**
 * pending の行の Issue を GitHub に作る (印で探して、無ければ作る)。作れたら、行を open にして子ならタスクを足すまでを 1 回のバッチで書く
 * @param ctx 呼び出しの材料
 * @param row 取った行
 * @param spec 作る 1 件
 * @param parent 子の時の親の番号と ID
 * @returns 書いた後の行
 */
async function materialize(ctx: Ctx, row: Row, spec: Spec, parent: { number: number; id: number } | null): Promise<Row> {
  const { env, issues, actor } = ctx;
  const found = ctx.byKey.get(spec.key);
  const made = found ?? (await issues.createIssue(row.repo, { title: spec.title, body: `${spec.body}\n${devIssueMark(spec.key)}`, labels: [...(spec.issueKind === null ? [] : [spec.issueKind]), ...(spec.high ? ["priority: high"] : [])] }));
  // 見つけた Issue にも毎回つなぐ。つなぐ前に落ちた時の直し。すでに子なら成功とみなす
  if (parent !== null) await issues.linkSubIssue(row.repo, parent.number, made.id);
  const state = found?.state ?? "open";
  const orm = drizzle(env.DB);
  const task = spec.kind === "child" && state === "open" ? await childTask(ctx, spec, made.number) : null;
  const update = orm
    .update(devIssues)
    .set({ number: made.number, issueId: made.id, parentNumber: parent?.number ?? null, state, closedAt: state === "closed" ? actor.now : null })
    .where(and(eq(devIssues.id, row.id), eq(devIssues.state, "pending")))
    .returning({ id: devIssues.id });
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [update];
  if (task !== null) statements.push(insertWhen(env.DB, nodes, task, sql`NOT EXISTS (SELECT 1 FROM ${nodes} WHERE ${nodes.source} = ${task.source} AND ${nodes.scope} = ${task.scope})`));
  const results: unknown[] = await orm.batch(statements);
  const added = z.object({ meta: z.object({ changes: z.number() }).loose() }).loose().safeParse(results[1]);
  if (task !== null && added.success && added.data.meta.changes > 0) {
    await recordCreated(env, task, actor);
    await notifyStaff(env, "builder", actor.now, false);
  }
  const [after] = await orm.select().from(devIssues).where(eq(devIssues.id, row.id)).limit(1);
  if (!after) throw new AppError("internal", "dev_issues の行が消えた");
  return after;
}

/**
 * 子の Issue の開発担当のタスクの行を作る
 * @param ctx 呼び出しの材料
 * @param spec 子の 1 件
 * @param number Issue の番号
 * @returns nodes の行
 */
async function childTask(ctx: Ctx, spec: Spec, number: number) {
  const { env, actor, service, docs } = ctx;
  const project = await intakeProject(env, service.id, actor);
  return newNodeRow(
    env,
    {
      kind: "task",
      parentId: project.id,
      scope: service.id,
      title: `#${String(number)} ${spec.requirement ?? ""}`,
      body: taskBody({ repo: service.repo, docs, spec, number }),
      taskKind: spec.issueKind === "bug" ? "fix" : "build",
      assignee: "builder",
      repo: service.repo,
      source: `issue:${String(number)}`,
      issueNumber: number,
      ...(spec.high ? { priority: 1 } : {}),
    },
    actor,
  );
}

/** 呼び出しの材料 */
type Ctx = {
  env: Bindings;
  issues: ReturnType<typeof publicDevIssues>;
  actor: Actor;
  service: { id: string; repo: string };
  /** 設計書のリポジトリと、サービスの置き場 (`<リポジトリ>/services/<名前>`) */
  docs: string;
  /** GitHub の今の Issue。印の鍵から */
  byKey: Map<string, DevIssue>;
  /** 番号から */
  byNumber: Map<number, DevIssue>;
};

/**
 * 子の Issue を閉じる。取っている作業 (doing か review のタスク) があれば閉じずに true を返し、無ければ GitHub で閉じていなければコメントが無い時だけ書いてから閉じ、行を closed にして、todo のタスクを取り消す
 * @param ctx 呼び出しの材料
 * @param row 開いた子の行
 * @param why 閉じる理由
 * @returns 取っている作業があって閉じなかった時は true
 */
async function closeChild(ctx: Ctx, row: Row, why: keyof typeof CLOSE_TEXT): Promise<boolean> {
  const { env, issues, actor } = ctx;
  const number = row.number ?? 0;
  const source = `issue:${String(number)}`;
  const orm = drizzle(env.DB);
  // 作っている途中のタスクを取り消さず、Issue も閉じない。社長に知らせるだけにする
  const [running] = await orm.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.source, source), eq(nodes.scope, row.serviceId), sql`${nodes.status} IN ('doing', 'review')`)).limit(1);
  if (running !== undefined) return true;
  const live = ctx.byNumber.get(number);
  if (live?.state !== "closed") {
    // 閉じるコメントは決まった文に印を付け、あれば書かない。書いた後に落ちて送り直しても二重にしない
    const marker = devIssueMark(row.markKey);
    if (!(await issues.hasComment(row.repo, number, marker))) await issues.comment(row.repo, number, `${CLOSE_TEXT[why]}\n${marker}`);
    await issues.closeNotPlanned(row.repo, number);
  }
  const [, dropped] = await orm.batch([
    orm.update(devIssues).set({ state: "closed", closedAt: actor.now }).where(and(eq(devIssues.id, row.id), eq(devIssues.state, "open"))),
    // 取り消せるのは取り掛かる前の todo だけ。doing と review は社長に知らせるだけにする
    orm.update(nodes).set({ status: "dropped", updatedAt: actor.now }).where(and(eq(nodes.source, source), eq(nodes.scope, row.serviceId), eq(nodes.status, "todo"))).returning({ id: nodes.id }),
  ]);
  for (const task of dropped) await appendNodeEvent(env, { nodeId: task.id, staffId: null, kind: "dropped", detail: { by: actor.by, why: CLOSE_TEXT[why] } }, actor);
  return false;
}

/**
 * 社長が送った親と子の組を、今の設計書で確かめて Issue にする。設計書の前には作らず、要件の名前が今の設計書に無ければ作らない
 * @param env バインディング
 * @param forge GitHub を呼ぶ口
 * @param input 送られた組
 * @param actor 呼んだ社員と今の時刻
 * @returns 作った物と今あった物の番号の一覧
 * @throws not_found サービスが無い時
 * @throws conflict 試作、サービス、運用の段階でない時、設計書のリポジトリかサービスのリポジトリが無い時、設計書がまだ無い時、別の呼び出しが同じ Issue を作っている時
 * @throws validation_failed 機能のファイルか要件が今の設計書に無い時、名前が伏せる形の時
 * @throws upstream_failed GitHub を読めない時、書けない時、Issue の一覧を読み切れない時
 */
export async function issuePlan(env: Bindings, forge: Forge, input: IssuePlanTool, actor: Actor): Promise<IssuePlanResult> {
  const service = await findService(env.DB, input.serviceId);
  if (!STAGES.includes(service.stage)) throw new AppError("conflict", "Issue を作れるのは試作、サービス、運用の段階のサービスだけ");
  if (service.repo === null) throw new AppError("conflict", "サービスのリポジトリが無い");
  const name = (service.repo.split("/")[1] ?? "").toLowerCase();
  if (!SERVICE_NAME.test(name)) throw new AppError("conflict", "サービスのリポジトリの名前が設計書の置き場にできない形");
  const docsRepo = await loadDocsRepo(env.DB);
  if (docsRepo === null) throw new AppError("conflict", "設計書のリポジトリを設定で選んでいない");
  // 設計書の前に開発のタスクを作らない。既定のブランチの今のコミットに README.md があるかで決め、読めなければ失敗にして作らない
  const head = await forge.defaultHead(docsRepo.repo);
  if ((await forge.readFile(docsRepo.repo, head, `services/${name}/README.md`)) === null) throw new AppError("conflict", "サービスの設計書がまだ設計書のリポジトリの main に入っていない");

  // 送られた機能のファイルを同じコミットで読み、要件の名前が今の設計書にあるかを確かめる
  const errors: { pointer: string; detail: string }[] = [];
  const features: { feature: string; featureName: string; hashes: Map<string, string>; specs: Spec[] }[] = [];
  const removed: Row[] = [];
  const pub = publicDevIssues(forge.issues);
  for (const [i, parent] of input.parents.entries()) {
    const text = await forge.readFile(docsRepo.repo, head, `services/${name}/docs/04-detail/${parent.feature}.md`);
    const pointer = `#/parents/${String(i)}/feature`;
    if (text === null) {
      // 子 0 件の親は、消えた機能の開いた子を閉じるだけの指定。子があれば、無い機能に作れないので断る
      if (parent.children.length > 0) errors.push({ pointer, detail: "今の設計書に無い機能のファイル" });
      else {
        const open = await drizzle(env.DB).select().from(devIssues).where(and(eq(devIssues.serviceId, service.id), eq(devIssues.kind, "child"), eq(devIssues.feature, parent.feature), eq(devIssues.state, "open")));
        // 閉じる子が 1 つも無い機能は書き間違いとして、何も書く前に断る
        if (open.length === 0) errors.push({ pointer, detail: "今の設計書に無く、閉じる子も無い機能のファイル" });
        else removed.push(...open);
      }
      continue;
    }
    const featureName = featureTitle(text);
    if (featureName === null || isRedactedName(featureName)) {
      errors.push({ pointer, detail: "機能の名前が決まった形でないか、伏せる形" });
      continue;
    }
    const reqs = await parseRequirements(text);
    const hashes = new Map(reqs.map((r) => [r.name, r.hash]));
    const specs: Spec[] = [];
    for (const [j, child] of parent.children.entries()) {
      const at = `#/parents/${String(i)}/children/${String(j)}/requirement`;
      const hash = hashes.get(child.requirement);
      if (hash === undefined) errors.push({ pointer: at, detail: "今の設計書の 1 章に無い要件の名前" });
      else if (isRedactedName(child.requirement)) errors.push({ pointer: at, detail: "伏せる形の名前は要件にできない" });
      else {
        const t = devIssueText({ feature: parent.feature, featureName, requirement: child.requirement });
        specs.push({ kind: "child", feature: parent.feature, requirement: child.requirement, hash, issueKind: child.kind, paths: child.paths, high: child.priority === "high", ...t, key: await devIssueKey({ serviceId: service.id, kind: "child", feature: parent.feature, requirement: child.requirement, hash }) });
      }
    }
    features.push({ feature: parent.feature, featureName, hashes, specs });
  }
  if (errors.length > 0) throw invalid(errors);

  // 印の探しは頭で一覧を 1 回だけ読んで表にする。読み切れなければ作らずに断る
  const listed = await pub.listIssues(service.repo);
  const byKey = new Map<string, DevIssue>();
  for (const issue of listed) {
    const key = devIssueKeyOf(issue.body);
    if (key !== null) byKey.set(key, issue);
  }
  const ctx: Ctx = { env, issues: pub, actor, service: { id: service.id, repo: service.repo }, docs: `${docsRepo.repo}/services/${name}`, byKey, byNumber: new Map(listed.map((i) => [i.number, i])) };

  const result: IssuePlanResult = { parents: [], children: [], closed: [], running: [], more: false };
  let closing = 0;
  /**
   * 閉じる子を 1 つ閉じる。上限を超えた分は次の issue_plan に回す
   * @param row 開いた子の行
   * @param why 理由
   */
  const close = async (row: Row, why: keyof typeof CLOSE_TEXT): Promise<void> => {
    if (closing >= CLOSE_MAX) {
      result.more = true;
      return;
    }
    closing += 1;
    if (await closeChild(ctx, row, why)) result.running.push(row.number ?? 0);
    else result.closed.push(row.number ?? 0);
  };

  for (const f of features) {
    const parentSpec: Spec = { kind: "parent", feature: f.feature, requirement: null, hash: null, issueKind: null, paths: null, high: false, ...devIssueText({ feature: f.feature, featureName: f.featureName, requirement: null }), key: await devIssueKey({ serviceId: service.id, kind: "parent", feature: f.feature, requirement: null, hash: null }) };
    const got = await claim(env, ctx.service, parentSpec, actor.now);
    let parent = got.owned ? await materialize(ctx, got.row, parentSpec, null) : got.row;
    const orm = drizzle(env.DB);
    for (const spec of f.specs) {
      const childClaim = await claim(env, ctx.service, spec, actor.now);
      if (childClaim.owned) {
        // 閉じた親に新しい子を付ける時は、親を開き直す
        if (parent.state === "closed" && parent.number !== null) {
          await pub.reopen(parent.repo, parent.number);
          await orm.update(devIssues).set({ state: "open", closedAt: null }).where(and(eq(devIssues.id, parent.id), eq(devIssues.state, "closed")));
          parent = { ...parent, state: "open", closedAt: null };
        }
        const done = await materialize(ctx, childClaim.row, spec, { number: parent.number ?? 0, id: parent.issueId ?? 0 });
        result.children.push({ feature: f.feature, requirement: spec.requirement ?? "", number: done.number ?? 0, created: true });
        // 同じ機能と要件でハッシュが違う開いた子は、新しい子に置き換わった
        const olds = await orm.select().from(devIssues).where(and(eq(devIssues.serviceId, service.id), eq(devIssues.kind, "child"), eq(devIssues.feature, f.feature), eq(devIssues.requirement, spec.requirement ?? ""), eq(devIssues.state, "open"), sql`${devIssues.reqHash} <> ${spec.hash ?? ""}`));
        for (const old of olds) await close(old, "replaced");
      } else {
        result.children.push({ feature: f.feature, requirement: spec.requirement ?? "", number: childClaim.row.number ?? 0, created: false });
      }
    }
    result.parents.push({ feature: f.feature, number: parent.number ?? 0 });
    // 今の設計書に無い要件の開いた子は閉じる
    const open = await orm.select().from(devIssues).where(and(eq(devIssues.serviceId, service.id), eq(devIssues.kind, "child"), eq(devIssues.feature, f.feature), eq(devIssues.state, "open")));
    for (const row of open) if (row.requirement !== null && !f.hashes.has(row.requirement)) await close(row, "removed");
  }
  // 設計書から消えた機能の開いた子は、すべて閉じる
  for (const row of removed) await close(row, "removed");
  await auditFrom(env, { at: actor.now, actor: actor.by, action: "devloop.issue_plan", target: service.id, scope: "office", detail: { parents: result.parents.length, created: result.children.filter((c) => c.created).length, closed: result.closed.length }, ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }) });
  return result;
}
