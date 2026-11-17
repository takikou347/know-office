// 設計書から作る Issue の決まった形。ラベル、設計書の要件の読み、題と本文、送り直しで同じ Issue を探す鍵 (開発の回し方の 3.3、3.4)
import { requirementsOf } from "./docs.ts";

/** 子 Issue の種類。ラベルと同じ名前 */
export const ISSUE_KINDS = ["bug", "feature", "chore"] as const;

/** 子 Issue の種類の型 */
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Issue に付けてよいラベルの 6 個だけ。ほかは付けない */
export const ISSUE_LABELS = ["bug", "feature", "chore", "priority: high", "blocked", "needs-owner"] as const;

/** Issue に付けてよいラベルの型 */
export type IssueLabel = (typeof ISSUE_LABELS)[number];

/** 親か子の Issue の種類 */
export type DevIssueKind = "parent" | "child";

/**
 * 文の SHA-256 を 16 進数の 64 字で返す
 * @param text 文
 * @returns 16 進数
 */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 詳細設計の機能のファイルの 1 章から、要件の名前と本文のハッシュを読む。2 章以降は読まない
 * @param markdown 詳細設計の機能のファイル
 * @returns 名前と、本文の SHA-256 の頭 16 字。出てきた順
 */
export async function parseRequirements(markdown: string): Promise<{ name: string; hash: string }[]> {
  return Promise.all(requirementsOf(markdown).map(async (r) => ({ name: r.name, hash: (await sha256(r.body)).slice(0, 16) })));
}

/**
 * 詳細設計の機能のファイルの見出し 1 から、機能の名前を読む。「# 詳細設計 <番号>. <名前>」の名前
 * @param markdown 詳細設計の機能のファイル
 * @returns 機能の名前。見出しが決まった形でなければ null
 */
export function featureTitle(markdown: string): string | null {
  return /^# 詳細設計 \d+\. (.+?)\s*$/m.exec(markdown)?.[1] ?? null;
}

/** 親か子の Issue の題と本文の素になる物。requirement は親なら null */
export type DevIssueSource = { feature: string; featureName: string; requirement: string | null };

/**
 * Issue の題と本文を組み立てる。設計書の本文、URL、触るファイル、社員の文は入れず、設計書の章の名前と済みの条件の決まった 1 文だけを書く。隠した印は gate の tracker.ts が足す
 * @param source 機能と要件
 * @returns 題と本文
 */
export function devIssueText(source: DevIssueSource): { title: string; body: string } {
  const target = source.requirement === null ? `機能「${source.featureName}」` : `要件「${source.requirement}」`;
  const done = source.requirement === null ? "済みの条件: 子 Issue がすべて閉じる" : "済みの条件: テスト設計の同じ要件のシナリオが通り、main に入る";
  return { title: source.requirement ?? source.featureName, body: [`設計書: 詳細設計 ${source.feature} の${target}`, done].join("\n") };
}

/**
 * 送り直しで同じ Issue を探す鍵を作る。サービス、種類、機能、要件、本文のハッシュから決まる SHA-256 の 64 字
 * @param source サービス ID、種類、機能、要件、本文のハッシュ
 * @param source.serviceId サービス ID
 * @param source.kind 親か子
 * @param source.feature 機能
 * @param source.requirement 要件の名前。親は null
 * @param source.hash 要件の本文のハッシュ。親は null
 * @returns 16 進数の 64 字
 */
export async function devIssueKey(source: { serviceId: string; kind: DevIssueKind; feature: string; requirement: string | null; hash: string | null }): Promise<string> {
  return sha256(JSON.stringify([source.serviceId, source.kind, source.feature, source.requirement, source.hash]));
}
