// ホーム。承認を待つ物をその場で決め、今日のタスク、今月の費用と日ごとの推移、動いているサービスの数値を入口の /dashboard から 1 回で読み、配信の印で読み直す。承認は承認の一覧から読む (API の records と settings)
import { type Approval, Dashboard, type HomeService, type OwnerReview } from "@know-office/core";
import { Alert, Chart, Grid, Link, List, Stack, Stat, Table } from "knowidea-ui";
import { useState } from "react";
import { useLiveTick } from "../../parts/live.tsx";
import { FailedAlert, type Loaded, useLoad } from "../../parts/load.tsx";
import { LiveNoticeList } from "../../parts/notices.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { NODE_STATUSES, taskHref } from "../../parts/tasks.ts";
import { ApprovalCard } from "../approvals/ApprovalsPage.tsx";
import { usePendingApprovals } from "../approvals/pending.ts";
import { WaitingStat } from "../approvals/Waiting.tsx";
import { labelOf } from "@know-office/core/master/master";
import { SERVICE_STAGES } from "@know-office/core/master/service-stages";
import { dollars } from "../services/labels.ts";
import { OwnerReviewCard } from "./OwnerReviewCard.tsx";

/** ホームでその場で決められる件数。残りは承認の一覧で決める */
export const HOME_WAITING_SHOWN = 5;

/**
 * サービスの種類ごとの数値を 1 行の文にする
 * @param service サービスの数値
 * @returns 数値の文
 */
export function serviceFigures(service: HomeService): string {
  const s = service.status;
  if (s.kind === "library") {
    const behind = s.usedBy.filter((u) => u.behind).length;
    return `版 ${s.version ?? "未公開"}、使うサービス ${String(s.usedBy.length)} (古い版 ${String(behind)})`;
  }
  if (s.kind === "web_app") {
    const users = s.users === null ? "未計測" : `${String(s.users)} 人`;
    const errors = s.errorRate === null ? "未計測" : `${(s.errorRate * 100).toFixed(1)}%`;
    return `24 時間の利用者 ${users}、失敗率 ${errors}、今月 ${dollars(s.costMicroUsd)}`;
  }
  return `公開 ${String(s.published.length)} 件、24 時間の読まれた数 ${s.reads === null ? "未計測" : String(s.reads)}`;
}

/**
 * 日本時間の日 YYYY-MM-DD を、グラフの軸の短い名 (11/3) にする
 * @param day 日
 * @returns 短い名
 */
function shortDay(day: string): string {
  const [, m = "", d = ""] = day.split("-");
  return `${String(Number(m))}/${String(Number(d))}`;
}

/** 承認を待つ物を古い順に並べた 1 件 */
type Waiting = { kind: "approval"; at: number; approval: Approval } | { kind: "review"; at: number; review: OwnerReview };

/**
 * 承認とレビューを、求めた時刻の古い順の 1 つの並びにする
 * @param approvals 決めていない承認
 * @param reviews オーナーの判断を待つレビュー
 * @returns 並び
 */
function waitingOf(approvals: Approval[], reviews: OwnerReview[]): Waiting[] {
  return [
    ...approvals.map((approval): Waiting => ({ kind: "approval", at: Date.parse(approval.requestedAt), approval })),
    ...reviews.map((review): Waiting => ({ kind: "review", at: Date.parse(review.requestedAt), review })),
  ].toSorted((a, b) => a.at - b.at);
}

/** ホーム */
export function DashboardPage() {
  const [decidedTick, setDecidedTick] = useState(0);
  const [done, setDone] = useState<{ tone: "success" | "warn"; text: string }>();
  const liveTick = useLiveTick((e) => e.type !== "message");
  const tick = liveTick + decidedTick;
  const loaded = useLoad(Dashboard, (a) => a.api.v1.dashboard.$get(), tick);
  const data = loaded.state === "ok" ? loaded.data : null;
  const pending = usePendingApprovals(tick);
  // オーナーの判断を待つレビューは入口の 1 回の返事に入っているので、配信の印で一緒に読み直る
  const reviews: Loaded<OwnerReview[]> = loaded.state === "ok" ? { state: "ok", data: loaded.data.ownerReviews } : loaded;
  const roleOf = (id: string | null) => data?.staff.find((s) => s.id === id)?.role ?? id ?? "";
  const decided = (text: string) => {
    setDone({ tone: "success", text });
    setDecidedTick((t) => t + 1);
  };
  const stale = (title: string, what = "はほかの所で先に決まっていました") => {
    setDone({ tone: "warn", text: `「${title}」${what}` });
    setDecidedTick((t) => t + 1);
  };

  const waitingBody = () => {
    if (pending.state === "loading" || reviews.state === "loading") return <p role="status">承認を待つ物を読んでいます</p>;
    if (pending.state === "failed") return <FailedAlert title="承認を待つ物を読めませんでした" failure={pending} />;
    if (reviews.state === "failed") return null;
    const items = waitingOf(pending.data, reviews.data);
    if (items.length === 0) return <p>承認を待つ物はありません</p>;
    return (
      <ul aria-label="承認を待つ物" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-3)" }}>
        {items.slice(0, HOME_WAITING_SHOWN).map((w) => (
          <li key={w.kind === "approval" ? w.approval.id : w.review.nodeId}>
            {w.kind === "approval" ? <ApprovalCard approval={w.approval} onDecided={decided} onStale={stale} /> : <OwnerReviewCard review={w.review} onDecided={decided} onStale={(title) => stale(title, "は確かめた後に変更が足されました。差分を見直してください")} />}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Section>
      {loaded.state === "loading" ? <p role="status">ホームを読んでいます</p> : null}
      {loaded.state === "failed" ? <FailedAlert title="ホームを読めませんでした" failure={loaded} /> : null}
      {data ? (
        <Grid minItemWidth={200}>
          <WaitingStat pending={pending} reviews={reviews} />
          <Stat label="今日のタスク" icon="flag" value={data.todayTasks.length} unit="件" />
          <Stat label="今月の費用" icon="chart-bar" value={(data.monthCostMicroUsd / 1_000_000).toFixed(2)} unit="ドル" sub="Claude API と Cloudflare の見込み" spark={data.dailyCosts.map((d) => d.costMicroUsd)} sparkLabel="今月の日ごとの Claude API の費用の推移" />
        </Grid>
      ) : null}
      <Part title="承認を待つ物">
        <Stack gap={3}>
          {done ? (
            <Alert tone={done.tone} live>
              {done.text}
            </Alert>
          ) : null}
          {waitingBody()}
          <Link href="/approvals" standalone>
            すべて見る
          </Link>
        </Stack>
      </Part>
      {data ? (
        <>
          <Part title="今日のタスク">
            <List
              label="今日のタスク"
              items={data.todayTasks.map((t) => ({
                id: t.id,
                title: t.title,
                href: t.assignee === null ? undefined : taskHref(t.assignee, t.id),
                meta: `${roleOf(t.assignee)}、${NODE_STATUSES[t.status].label}`,
              }))}
              emptyText="今日のタスクはありません"
            />
          </Part>
          <Part title="費用の推移">
            <Chart
              ariaLabel="今月の日ごとの費用"
              unit="ドル"
              data={data.dailyCosts.map((d) => ({ key: d.day, label: shortDay(d.day), detail: d.day, value: Number((d.costMicroUsd / 1_000_000).toFixed(2)) }))}
              state={data.dailyCosts.some((d) => d.costMicroUsd > 0) ? "ready" : "empty"}
              emptyText="今月の費用のデータがありません"
            />
          </Part>
          <Part title="サービスの数値">
            <Table
              label="サービスの数値"
              rowKey={(r) => r.id}
              rows={data.services.map((s) => ({ id: s.id, name: s.name, stage: labelOf(SERVICE_STAGES, s.stage), figures: serviceFigures(s) }))}
              columns={[
                { key: "name", header: "サービス", render: (r) => <a href={`/services/${r.id}`}>{r.name}</a> },
                { key: "stage", header: "段階" },
                { key: "figures", header: "数値", wrap: true },
              ]}
              emptyText="数値を出すサービスはありません"
            />
          </Part>
        </>
      ) : null}
      <Part title="お知らせ">
        <LiveNoticeList />
      </Part>
    </Section>
  );
}
