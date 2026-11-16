// 記録の画面。office 全体の勤怠を入口の /records/attendance から新しい日から読み、サービスごとと社員ごとの内訳を並べる (ルートの一覧の 1.4)
import { DaySummary, jstDay, StaffOverview, systemClock } from "@know-office/core";
import { Table } from "knowidea-ui";
import { z } from "zod";
import { duration, jstTime } from "../../format.ts";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { RecordBreakdown } from "./RecordBreakdown.tsx";

/** 勤怠を読む日の数。今日から前へ数える */
const ATTENDANCE_DAYS = 30;

/** 1 日のミリ秒 */
const DAY_MS = 86_400_000;

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
      <Part title="勤怠">
        <OfficeAttendance />
      </Part>
      <Part title="内訳">
        <RecordBreakdown />
      </Part>
    </Section>
  );
}
