// ダッシュボード。社員の様子、可を待つ物、今日の仕事、今月の費用、お知らせを 1 つに並べる。社員とタスクと費用は仮のデータ
import type { Health } from "@know-office/core";
import { Card, Grid, List, Stat } from "knowidea-ui";
import { monthCost, staff } from "../../mock.ts";
import { LiveNoticeList } from "../../parts/notices.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { StaffStatus } from "../../parts/staff-status.tsx";
import { reviewHref, roleOf } from "../../parts/tasks.ts";
import { useWorkTasks } from "../office/feed.ts";

export interface DashboardPageProps {
  /** 入口の様子。受け取る前は無い */
  health?: Health | undefined;
}

export function DashboardPage({ health }: DashboardPageProps) {
  const working = staff.filter((s) => s.state === "working").length;
  const tasks = useWorkTasks();
  const waiting = tasks.filter((t) => t.state === "可待ち");
  const today = tasks.filter((t) => t.state === "今");
  return (
    <Section>
      <p>{health ? "入口とつながりました" : "入口を確かめています"}</p>
      <Grid minItemWidth={200}>
        <Stat label="働いている社員" icon="users" value={working} unit="人" sub={`全体 ${staff.length}`} />
        <Stat label="可を待つ物" icon="flag" value={waiting.length} unit="件" />
        <Stat label="今月の費用" icon="chart-bar" value={monthCost.used} unit="ドル" sub={`見込み ${monthCost.budget} ドル`} />
      </Grid>
      <Part title="社員の様子">
        <Grid minItemWidth={260}>
          {staff.map((s) => (
            <Card key={s.id} title={s.role} subtitle={s.model} badge={<StaffStatus s={s} />} href={`/staff/${s.id}`}>
              {s.now}
            </Card>
          ))}
        </Grid>
      </Part>
      <Part title="可を待つ物">
        <List
          label="可を待つ物"
          items={waiting.map((t) => ({ id: t.id, title: t.title, href: reviewHref(t), meta: `${roleOf(t.staffId)}、${t.service}` }))}
          emptyText="可を待つ物は無い"
        />
      </Part>
      <Part title="今日の仕事">
        <List
          label="今日の仕事"
          items={today.map((t) => ({
            id: t.id,
            title: t.title,
            href: `/staff/${t.staffId}?tab=tasks`,
            meta: `${roleOf(t.staffId)}、${t.service}`,
          }))}
        />
      </Part>
      <Part title="お知らせ">
        <LiveNoticeList />
      </Part>
    </Section>
  );
}
