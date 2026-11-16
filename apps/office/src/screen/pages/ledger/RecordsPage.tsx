// 記録の画面。今月の稼働率を入口の /records/uptime から、office 全体の勤怠を /records/attendance から新しい日から読み、サービスごとと社員ごとの内訳を並べる (ルートの一覧の 1.4)
import { DaySummary, jstDay, StaffOverview, systemClock, Uptime } from "@know-office/core";
import { Grid, Stat, Table } from "knowidea-ui";
import { z } from "zod";
import { duration, jstTime } from "../../format.ts";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { RecordBreakdown } from "./RecordBreakdown.tsx";

/** 勤怠を読む日の数。今日から前へ数える */
const ATTENDANCE_DAYS = 30;

/** 1 日のミリ秒 */
const DAY_MS = 86_400_000;

/** 稼働率の目安。月の稼働率をこの割合と並べて出す */
const UPTIME_TARGET = 0.999;

/**
 * 今月 (日本時間) の稼働率。5 分ごとの確かめの通った割合を、目安の 99.9% と並べて出す
 * @returns 稼働率の数字
 */
function MonthUptime() {
  const month = jstDay(systemClock.now()).slice(0, 7);
  const loaded = useLoad(Uptime, (a) => a.api.v1.records.uptime.$get({ query: { month } }));
  if (loaded.state === "failed") return <FailedAlert title="稼働率を読めませんでした" failure={loaded} />;
  if (loaded.state === "loading") return <p role="status">稼働率を読んでいます</p>;
  const { ratio, checks } = loaded.data;
  const target = `目安 ${(UPTIME_TARGET * 100).toFixed(1)}%`;
  return (
    <Grid minItemWidth={200}>
      <Stat
        label={`${month} の稼働率`}
        icon="chart-bar"
        value={ratio === null ? "まだ無い" : (Math.floor(ratio * 10_000) / 100).toFixed(2)}
        unit={ratio === null ? undefined : "%"}
        sub={`${target}、確かめた ${String(checks)} 件`}
      />
    </Grid>
  );
}

/**
 * office 全体の勤怠の表。社員の役の名前は /staff から読む
 * @returns 表
 */
function OfficeAttendance() {
  const now = systemClock.now();
  const from = jstDay(now - (ATTENDANCE_DAYS - 1) * DAY_MS);
  const to = jstDay(now);
  const loaded = useLoad(z.array(DaySummary), (a) => a.api.v1.records.attendance.$get({ query: { from, to, limit: "100" } }));
  const people = useLoad(z.array(StaffOverview), (a) => a.api.v1.staff.$get({ query: {} }));
  if (loaded.state === "failed") return <FailedAlert title="勤怠を読めませんでした" failure={loaded} />;
  const roleOf = (id: string) => (people.state === "ok" ? people.data.find((s) => s.id === id)?.role : undefined) ?? id;
  const rows = loaded.state === "ok" ? loaded.data : [];
  return (
    <Table
      label="office 全体の勤怠"
      loading={loaded.state === "loading"}
      rowKey={(r) => `${r.day}.${r.staffId}`}
      rows={rows}
      columns={[
        { key: "day", header: "日", numeric: true },
        { key: "staffId", header: "社員", render: (r) => roleOf(r.staffId) },
        { key: "clockIn", header: "出勤", numeric: true, render: (r) => (r.clockIn === null ? "なし" : jstTime(r.clockIn)) },
        { key: "clockOut", header: "退勤", numeric: true, render: (r) => (r.clockOut === null ? "なし" : jstTime(r.clockOut)) },
        { key: "workedMs", header: "働いた", numeric: true, render: (r) => duration(Math.round(r.workedMs / 60_000)) },
      ]}
      emptyText={`この ${String(ATTENDANCE_DAYS)} 日の勤怠は無い`}
    />
  );
}

/**
 * 記録の画面
 * @returns 画面
 */
export function RecordsPage() {
  return (
    <Section>
      <Part title="稼働率">
        <MonthUptime />
      </Part>
      <Part title="勤怠">
        <OfficeAttendance />
      </Part>
      <Part title="内訳">
        <RecordBreakdown />
      </Part>
    </Section>
  );
}
