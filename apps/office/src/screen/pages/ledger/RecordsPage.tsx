// 記録の画面。勤怠、タスク、費用、トークン、エラーをタブに分け、上で選んだ月の値を出す。勤怠は社員と日の表、タスクと費用とトークンはサービスごとと社員ごとの内訳、エラーは月の稼働率と新しいエラーログで、クエリの trace の要求をたどる (API の records、ログインと記録の 3.6、サービスと拡張の 3.4)
import { jstDay, systemClock, Uptime } from "@know-office/core";
import { Grid, Select, Stack, Stat, Tabs } from "knowidea-ui";
import { RECORD_TABS, type RecordTab } from "@know-office/core/master/record-tab";
import { type ReactNode, useState } from "react";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { ErrorLog, TraceView } from "./ErrorTrail.tsx";
import { MonthAttendance } from "./MonthAttendance.tsx";
import { RecordBreakdown } from "./RecordBreakdown.tsx";
import { monthLabel, recentMonths } from "./month.ts";

/** 選べる月の数。今月から前へ数える */
const MONTHS_SHOWN = 12;

/** 稼働率の目安。月の稼働率をこの割合と並べて出す */
const UPTIME_TARGET = 0.999;

const isRecordTab = (v: string | null): v is RecordTab => RECORD_TABS.some((t) => t.value === v);

/**
 * 道の問いから開くタブを決める。tab があればそれ、trace があればエラー、ほかは勤怠
 * @param query 道の問い
 * @returns 開くタブ
 */
export function recordTabOf(query: URLSearchParams): RecordTab {
  const tab = query.get("tab");
  if (isRecordTab(tab)) return tab;
  return query.get("trace") === null ? "attendance" : "errors";
}

/**
 * 選んだ月の稼働率。5 分ごとの確かめの通った割合を、目安の 99.9% と並べて出す
 * @param props 月
 * @param props.month YYYY-MM
 * @returns 稼働率の数字
 */
function MonthUptime({ month }: { month: string }) {
  const loaded = useLoad(Uptime, (a) => a.api.v1.records.uptime.$get({ query: { month } }));
  if (loaded.state === "failed") return <FailedAlert title="稼働率を読めませんでした" failure={loaded} />;
  if (loaded.state === "loading") return <p role="status">稼働率を読んでいます</p>;
  const { ratio, checks } = loaded.data;
  const target = `目安 ${(UPTIME_TARGET * 100).toFixed(1)}%`;
  return (
    <Grid minItemWidth={200}>
      <Stat
        label={`${monthLabel(month)}の稼働率`}
        icon="chart-bar"
        value={ratio === null ? "データがありません" : (Math.floor(ratio * 10_000) / 100).toFixed(2)}
        unit={ratio === null ? undefined : "%"}
        sub={`${target}、確かめた ${String(checks)} 件`}
      />
    </Grid>
  );
}

export interface RecordsPageProps {
  /** 道のクエリ。tab で開くタブを、trace があればその要求をたどる所を頭に出す */
  query: URLSearchParams;
}

/**
 * 記録の画面
 * @param props 道のクエリ
 * @returns 画面
 */
export function RecordsPage({ query }: RecordsPageProps) {
  const trace = query.get("trace");
  const today = jstDay(systemClock.now());
  const months = recentMonths(today, MONTHS_SHOWN);
  const [month, setMonth] = useState(months[0] ?? today.slice(0, 7));
  const [tab, setTab] = useState<RecordTab>(() => recordTabOf(query));
  // タブの並びと名前はマスタデータから取り、中身だけをここで決める
  const contents: Record<RecordTab, ReactNode> = {
    attendance: <MonthAttendance month={month} today={today} />,
    tasks: <RecordBreakdown metric="tasks" month={month} />,
    cost: <RecordBreakdown metric="cost" month={month} />,
    tokens: <RecordBreakdown metric="tokens" month={month} />,
    errors: (
      <Stack gap={6}>
        <Part title="稼働率">
          <MonthUptime key={month} month={month} />
        </Part>
        <Part title="エラーログ">
          <ErrorLog />
        </Part>
      </Stack>
    ),
  };
  return (
    <Section>
      {trace === null ? null : (
        <Part title="要求をたどる">
          <TraceView key={trace} traceId={trace} />
        </Part>
      )}
      <Stack gap={3}>
        <Select
          aria-label="見る月"
          value={month}
          options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
          onValueChange={(v) => {
            if (v !== null && months.includes(v)) setMonth(v);
          }}
        />
        <Tabs
          label="記録の種類"
          value={tab}
          onValueChange={(v) => {
            if (isRecordTab(v)) setTab(v);
          }}
          items={RECORD_TABS.map((t) => ({ value: t.value, label: t.label, content: contents[t.value] }))}
        />
      </Stack>
    </Section>
  );
}
