// ダッシュボード。社員の様子、今日のタスク、今月の費用を入口の /dashboard から 1 回で読み、配信の印で読み直す。承認を待つ物は承認の一覧から読み、お知らせと並べる (ルートの一覧の 1.12)
import { Dashboard, type Health } from "@know-office/core";
import { Card, Grid, List, Stat } from "knowidea-ui";
import { useLiveTick } from "../../parts/live.tsx";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { LiveNoticeList } from "../../parts/notices.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { AT_WORK, StaffStatus } from "../../parts/staff-status.tsx";
import { NODE_STATUSES, taskHref } from "../../parts/tasks.ts";
import { usePendingApprovals } from "../approvals/pending.ts";
import { WaitingList, WaitingStat } from "../approvals/Waiting.tsx";

/**
 * 100 万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 100 万分の 1 ドル
 * @returns ドルの文
 */
function dollars(micro: number): string {
  return (micro / 1_000_000).toFixed(2);
}

export interface DashboardPageProps {
  /** 入口の様子。受け取る前は無い */
  health?: Health | undefined;
}

/**
 * ダッシュボード
 * @param props 入口の様子
 * @returns 画面
 */
export function DashboardPage({ health }: DashboardPageProps) {
  const tick = useLiveTick((e) => e.type !== "message");
  const loaded = useLoad(Dashboard, (a) => a.api.v1.dashboard.$get(), tick);
  const data = loaded.state === "ok" ? loaded.data : null;
  const pending = usePendingApprovals();
  const roleOf = (id: string | null) => data?.staff.find((s) => s.id === id)?.role ?? id ?? "";
  return (
    <Section>
      <p>{health ? "入口とつながりました" : "入口を確かめています"}</p>
      {loaded.state === "loading" ? <p role="status">ダッシュボードを読んでいます</p> : null}
      {loaded.state === "failed" ? <FailedAlert title="ダッシュボードを読めませんでした" failure={loaded} /> : null}
      {data ? (
        <>
          <Grid minItemWidth={200}>
            <Stat label="働いている社員" icon="users" value={data.staff.filter((s) => AT_WORK.includes(s.state)).length} unit="人" sub={`全体 ${String(data.staff.length)}`} />
            <WaitingStat pending={pending} />
            <Stat label="今月の費用" icon="chart-bar" value={dollars(data.monthCostMicroUsd)} unit="ドル" />
          </Grid>
          <Part title="社員の様子">
            <Grid minItemWidth={260}>
              {data.staff.map((s) => (
                <Card key={s.id} title={s.role} subtitle={s.model} badge={<StaffStatus state={s.state} />} href={`/staff/${s.id}`}>
                  {s.nodeTitle ?? "今のタスクは無い"}
                </Card>
              ))}
            </Grid>
          </Part>
        </>
      ) : null}
      <Part title="承認を待つ物">
        <WaitingList pending={pending} />
      </Part>
      {data ? (
        <Part title="今日の仕事">
          <List
            label="今日の仕事"
            items={data.todayTasks.map((t) => ({
              id: t.id,
              title: t.title,
              href: t.assignee === null ? undefined : taskHref(t.assignee, t.id),
              meta: `${roleOf(t.assignee)}、${NODE_STATUSES[t.status].label}`,
            }))}
            emptyText="今日の仕事は無い"
          />
        </Part>
      ) : null}
      <Part title="お知らせ">
        <LiveNoticeList />
      </Part>
    </Section>
  );
}
