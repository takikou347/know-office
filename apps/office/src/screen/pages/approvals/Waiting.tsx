// ダッシュボードの、オーナーの承認を待つ物。承認とオーナーの判断を待つレビューの件数と先頭の数件を出し、承認は決める画面へ、レビューは社員と仕事のレビューへ移る (タスクとレビューの 3.4)
import { APPROVAL_KIND_LABEL, type Approval, type OwnerReview } from "@know-office/core";
import { Link, List, Stat } from "knowidea-ui";
import { jstDateTime } from "../../format.ts";
import type { Loaded } from "../../parts/load.tsx";
import { taskHref } from "../../parts/tasks.ts";
import { approvalTitle, requesterName } from "./kinds.ts";
import { PENDING_LIMIT } from "./pending.ts";

/** ダッシュボードに並べる件数 */
export const WAITING_SHOWN = 5;

export interface WaitingProps {
  /** 決めていない承認を古い順に読んだ物 */
  pending: Loaded<Approval[]>;
  /** オーナーの判断を待つレビューを古い順に読んだ物。ダッシュボードの入口から読む */
  reviews: Loaded<OwnerReview[]>;
}

/** 承認とレビューをまとめた読み方。読めた時は両方を持つ */
type Both = { state: "loading" | "failed" } | { state: "ok"; approvals: Approval[]; reviews: OwnerReview[] };

/**
 * 承認とレビューの両方の読み方をまとめる。どちらかが読めなければ読めなかった事に、どちらかを読んでいれば読んでいる事にする
 * @param props 承認とレビュー
 * @returns まとめた読み方
 */
function both({ pending, reviews }: WaitingProps): Both {
  if (pending.state === "failed" || reviews.state === "failed") return { state: "failed" };
  if (pending.state === "loading" || reviews.state === "loading") return { state: "loading" };
  return { state: "ok", approvals: pending.data, reviews: reviews.data };
}

/** 承認を待つ物の件数。承認とオーナーの判断を待つレビューを足す。読めなければ数を出さない */
export function WaitingStat(props: WaitingProps) {
  const read = both(props);
  const count = read.state === "ok" ? read.approvals.length + read.reviews.length : null;
  // どちらも 100 件までしか読まないので、どちらかが上限に届けば、まだあるかもしれない
  const more = read.state === "ok" && (read.approvals.length >= PENDING_LIMIT || read.reviews.length >= PENDING_LIMIT);
  const sub = more ? `${String(PENDING_LIMIT)} 件より多いかもしれない` : undefined;
  return <Stat label="承認を待つ物" icon="flag" value={count} unit="件" fallback={read.state === "loading" ? "読んでいます" : "読めませんでした"} {...(sub ? { sub } : {})} />;
}

/** 一覧の 1 行と、並べる時刻 */
type Row = { item: { id: string; title: string; href?: string; meta: string }; at: number };

/**
 * 承認とレビューを、求めた時刻の古い順の 1 つの並びにする
 * @param approvals 決めていない承認
 * @param reviews オーナーの判断を待つレビュー
 * @returns 一覧の行
 */
function rowsOf(approvals: Approval[], reviews: OwnerReview[]): Row[] {
  const fromApprovals = approvals.map((a) => ({ item: { id: a.id, title: approvalTitle(a), href: `/approvals/${a.id}`, meta: `${requesterName(a.requestedBy)}、${jstDateTime(a.requestedAt)}` }, at: Date.parse(a.requestedAt) }));
  // レビューは承認の画面で決めないので、決める所の社員と仕事のレビューへ直に移る
  const fromReviews = reviews.map((r) => ({
    item: {
      id: r.nodeId,
      title: `${APPROVAL_KIND_LABEL.merge}: ${r.title}`,
      ...(r.assignee === null ? {} : { href: taskHref(r.assignee, r.nodeId) }),
      meta: r.assignee === null ? jstDateTime(r.requestedAt) : `${requesterName(r.assignee)}、${jstDateTime(r.requestedAt)}`,
    },
    at: Date.parse(r.requestedAt),
  }));
  return [...fromApprovals, ...fromReviews].toSorted((a, b) => a.at - b.at);
}

/**
 * 一覧の様子を決める
 * @param read まとめた読み方
 * @param shown 出す行の数
 * @returns 一覧の様子
 */
function listState(read: Both, shown: number): "loading" | "ready" | "empty" | "error" {
  if (read.state === "loading") return "loading";
  if (read.state === "failed") return "error";
  return shown === 0 ? "empty" : "ready";
}

/** 承認を待つ物の先頭の数件。承認の行は承認を決める画面の 1 件へ、レビューの行はそのレビューへ、「すべて見る」は承認の一覧へ移る */
export function WaitingList(props: WaitingProps) {
  const read = both(props);
  const items = read.state === "ok" ? rowsOf(read.approvals, read.reviews).slice(0, WAITING_SHOWN).map((r) => r.item) : [];
  return (
    <>
      <List label="承認を待つ物" state={listState(read, items.length)} items={items} emptyText="承認を待つ物は無い" errorText="承認を待つ物を読めませんでした" loadingText="承認を待つ物を読んでいます" />
      <Link href="/approvals" standalone>
        すべて見る
      </Link>
    </>
  );
}
