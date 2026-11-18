// ダッシュボードの、オーナーの承認を待つ物。件数と先頭の数件を出し、1 件ずつと一覧の承認を決める画面へ移る (タスクとレビューの 3.4)
import type { Approval } from "@know-office/core";
import { Link, List, Stat } from "knowidea-ui";
import { jstDateTime } from "../../format.ts";
import type { Loaded } from "../../parts/load.tsx";
import { approvalTitle, requesterName } from "./kinds.ts";
import { PENDING_LIMIT } from "./pending.ts";

/** ダッシュボードに並べる件数 */
export const WAITING_SHOWN = 5;

export interface WaitingProps {
  /** 決めていない承認を古い順に読んだ物 */
  pending: Loaded<Approval[]>;
}

/** 承認を待つ物の件数。読めなければ数を出さない */
export function WaitingStat({ pending }: WaitingProps) {
  const count = pending.state === "ok" ? pending.data.length : null;
  const sub = count !== null && count >= PENDING_LIMIT ? `${String(PENDING_LIMIT)} 件より多いかもしれない` : undefined;
  return <Stat label="承認を待つ物" icon="flag" value={count} unit="件" fallback={pending.state === "loading" ? "読んでいます" : "読めませんでした"} {...(sub ? { sub } : {})} />;
}

/**
 * 一覧の様子を決める
 * @param pending 読んだ物
 * @returns 一覧の様子
 */
function listState(pending: Loaded<Approval[]>): "loading" | "ready" | "empty" | "error" {
  if (pending.state === "loading") return "loading";
  if (pending.state === "failed") return "error";
  return pending.data.length === 0 ? "empty" : "ready";
}

/** 承認を待つ物の先頭の数件。各行は承認を決める画面の 1 件へ、「すべて見る」は一覧へ移る */
export function WaitingList({ pending }: WaitingProps) {
  const items = pending.state === "ok" ? pending.data.slice(0, WAITING_SHOWN) : [];
  const state = listState(pending);
  return (
    <>
      <List
        label="承認を待つ物"
        state={state}
        items={items.map((a) => ({ id: a.id, title: approvalTitle(a), href: `/approvals/${a.id}`, meta: `${requesterName(a.requestedBy)}、${jstDateTime(a.requestedAt)}` }))}
        emptyText="承認を待つ物は無い"
        errorText="承認を待つ物を読めませんでした"
        loadingText="承認を待つ物を読んでいます"
      />
      <Link href="/approvals" standalone>
        すべて見る
      </Link>
    </>
  );
}
