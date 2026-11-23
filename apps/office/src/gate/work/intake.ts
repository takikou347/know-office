// 受け付け。Issue とオーナーの発言を、受け付けのプロジェクトの下のタスクにする (タスクとレビューの 3.1、会話の 3.9)
import { headChars, jstClock, jstDay, type StaffId, type StaffJob, type TaskKind } from "@know-office/core";
import { sql } from "drizzle-orm";
import { nodes } from "../db/main.ts";
import { insertWhenStatement } from "../db/when.ts";
import type { Bindings } from "../env.ts";
import { announce } from "../live/publish.ts";
import { clockAt } from "./attendance.ts";
import { notifyStaff } from "./loop.ts";
import { type Actor, createNode, intakeProject, newNodeRow, recordCreated } from "./nodes.ts";
import { pickStaff } from "./roster.ts";

/** 受け付ける選んだリポジトリの Issue。オーナーの発言は intakeMessage で受ける */
export type Intake = { scope: string; title: string; body: string; source: "issue"; issueNumber: number };

/**
 * Issue を、受け付けのプロジェクトの下に社長が分けるタスクとして足す
 * @param env バインディング
 * @param input 受け付ける物
 * @param now 今の時刻
 * @returns 足したタスクの ID
 */
export async function intakeTask(env: Bindings, input: Intake, now: number): Promise<string> {
  const actor: Actor = { by: "github", now };
  const project = await intakeProject(env, input.scope, actor);
  const row = await createNode(
    env,
    { kind: "task", parentId: project.id, scope: input.scope, title: input.title, body: input.body, taskKind: "plan", assignee: await pickStaff(env.DB, "president"), source: input.source, issueNumber: input.issueNumber },
    actor,
  );
  // 勤務時間外には呼び出さず、手の空いた社長が次に取る
  if (row.assignee !== null) await notifyStaff(env, row.assignee, now, false);
  return row.id;
}

/** 発言から作るタスクの題の長さの上限 (コードポイント) */
const INTAKE_TITLE_CHARS = 80;

/** 発言のタスクの優先。オーナーの言葉を、山が空の時の分けるタスクや Issue の物 (100) より先に取らせる */
const INTAKE_PRIORITY = 0;

/**
 * 発言の最初の空でない行の頭から、タスクの題を作る
 * @param body 発言の本文
 * @returns 題
 */
function intakeTitle(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line === "" ? "オーナーの発言" : headChars(line, INTAKE_TITLE_CHARS);
}

/** 職種ごとの、発言から作るタスクの種類。社長は分け、開発担当は作り、レビュー担当は調べて書く */
const INTAKE_KIND: Record<StaffJob, TaskKind> = { president: "plan", builder: "build", reviewer: "content" };

/** 職種ごとの、発言から作るタスクの本文の頭 */
const INTAKE_LEAD: Record<StaffJob, string> = {
  president: "読んでタスクに分け、山に足す。",
  builder: "頼みのとおりに進める。",
  reviewer: "頼みのとおりに調べて書く。",
};

/** 発言をタスクにする先。社員と、頼みを入れる範囲 */
export type IntakeTarget = { staffId: StaffId; job: StaffJob; scope: string };

/**
 * 社員への発言を、範囲の受け付けのプロジェクトの下にその社員のタスクとして足し、同じバッチで渡した印 task を付ける。
 * 同じ発言のタスクか、渡した印 (呼び出しの頭で先に渡った物) がもうあれば何も足さない
 * @param env バインディング
 * @param message 発言の ID と時刻と本文
 * @param message.id 発言 ID
 * @param message.at 発言の時刻
 * @param message.body 本文
 * @param now 今の時刻
 * @param traceId 話しかけた要求の traceId
 * @param target 足す先の社員と範囲。省くと社長と office
 * @returns 足したタスクの ID。足さなかった時は null
 */
export async function intakeMessage(env: Bindings, message: { id: string; at: number; body: string }, now: number, traceId?: string, target?: IntakeTarget): Promise<string | null> {
  const to: IntakeTarget = target ?? { staffId: await pickStaff(env.DB, "president"), job: "president", scope: "office" };
  const actor: Actor = { by: "owner", now, traceId };
  const project = await intakeProject(env, to.scope, actor);
  const source = `chat:${message.id}`;
  const row = await newNodeRow(
    env,
    {
      kind: "task",
      parentId: project.id,
      scope: to.scope,
      title: intakeTitle(message.body),
      body: `オーナーの発言 (日本時間 ${jstDay(message.at)} ${jstClock(message.at)})。${INTAKE_LEAD[to.job]}\n\n${message.body}`,
      taskKind: INTAKE_KIND[to.job],
      assignee: to.staffId,
      priority: INTAKE_PRIORITY,
      source,
    },
    actor,
  );
  // タスクと印を 1 回のバッチで書き、片方だけを残さない。呼び出しの頭が先に印を付けた発言は、社長がもう読んだのでタスクにしない
  const [added] = await env.DB.batch([
    insertWhenStatement(
      env.DB,
      nodes,
      row,
      sql`NOT EXISTS (SELECT 1 FROM ${nodes} WHERE ${nodes.source} = ${source}) AND NOT EXISTS (SELECT 1 FROM message_deliveries WHERE message_id = ${message.id})`,
    ),
    env.DB.prepare(
      "INSERT INTO message_deliveries (message_id, staff_id, node_id, via, delivered_at) SELECT ?, ?, ?, 'task', ? WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?) ON CONFLICT(message_id) DO NOTHING",
    ).bind(message.id, row.assignee, row.id, now, row.id),
  ]);
  if (added?.meta.changes !== 1) return null;
  await recordCreated(env, row, actor);
  await announce(env, { type: "message_delivered", delivery: { id: message.id, via: "task", at: new Date(now).toISOString(), taskId: row.id } }, clockAt(now));
  // 勤務時間外には呼び出さず、手の空いた社員が次に取る
  if (row.assignee !== null) await notifyStaff(env, row.assignee, now, false, traceId);
  return row.id;
}
