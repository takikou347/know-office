// 記録の画面の勤怠のタブ。選んだ月の office 全体の勤怠を /records/attendance からページを追って読み、日ごとの行と社員ごとの列の表に、社員ごとの月の合計を添えて出す (画面の全体の画面の一覧)
import { DaySummary, ListMeta, StaffOverview } from "@know-office/core";
import { Table } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { dayLabel, duration, jstTime } from "../../format.ts";
import { FailedAlert, failureOf, type Loaded, useLoad } from "../../parts/load.tsx";
import { attendanceGrid, monthDays, monthRange } from "./month.ts";

const Page = z.object({ data: z.array(DaySummary), meta: ListMeta }).loose();

/** 1 ページの件数。入口の上限 */
const PAGE_LIMIT = 100;

/** 追うページの上限。社員 10 人の 31 日でも足りる数にし、壊れたカーソルで回り続けない */
const MAX_PAGES = 5;

/**
 * 月の勤怠を、次のページのカーソルが無くなるまで読む
 * @param month YYYY-MM
 * @returns 読んでいる、読めた、読めなかった
 */
function useMonthAttendance(month: string): Loaded<DaySummary[]> {
  const api = useContext(ApiContext);
  const [loaded, setLoaded] = useState<{ month: string; value: Loaded<DaySummary[]> } | null>(null);
  useEffect(() => {
    let live = true;
    const { from, to } = monthRange(month);
    const read = async (): Promise<Loaded<DaySummary[]>> => {
      // 入口を呼ぶ口が無い時は読みに行かない。返す形は下で読めなかった事にする
      if (!api) throw new Error("入口を呼ぶ口が無い");
      const rows: DaySummary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = { from, to, limit: String(PAGE_LIMIT), ...(cursor === null ? {} : { cursor }) };
        const res = await api.api.v1.records.attendance.$get({ query });
        if (!res.ok) return { state: "failed", ...(await failureOf(res)) };
        const body = Page.parse(await res.json());
        rows.push(...body.data);
        cursor = body.meta.next;
        if (cursor === null) break;
      }
      return { state: "ok", data: rows };
    };
    void read()
      .catch((): Loaded<DaySummary[]> => ({ state: "failed", code: "network", traceId: null }))
      .then((value) => {
        if (live) setLoaded({ month, value });
      });
    return () => {
      live = false;
    };
  }, [api, month]);
  // 入口を呼ぶ口が無ければ読みに行けないので、読んでいるままにしない
  if (!api) return { state: "failed", code: "network", traceId: null };
  return loaded?.month === month ? loaded.value : { state: "loading" };
}

/**
 * 1 日の勤怠を、開始と終了の時刻と働いた時間の文にする
 * @param d 1 日のまとめ。無ければ null
 * @returns 「9:00–17:10 7 時間 55 分」の形。無ければ「なし」
 */
function cellText(d: DaySummary | null | undefined): string {
  if (!d) return "なし";
  const start = d.clockIn === null ? "" : jstTime(d.clockIn);
  const end = d.clockOut === null ? "" : jstTime(d.clockOut);
  const span = start === "" && end === "" ? "" : `${start}–${end} `;
  return `${span}${duration(Math.floor(d.workedMs / 60_000))}`;
}

export interface MonthAttendanceProps {
  /** 見る月 YYYY-MM */
  month: string;
  /** 日本時間の今日 YYYY-MM-DD。今月は今日までの日を出す */
  today: string;
}

/**
 * 選んだ月の勤怠の表。行は日、列は社員で、最後の行に社員ごとの合計を置く
 * @param props 月と今日
 * @returns 表
 */
export function MonthAttendance({ month, today }: MonthAttendanceProps) {
  const loaded = useMonthAttendance(month);
  const people = useLoad(z.array(StaffOverview), (a) => a.api.v1.staff.$get({ query: {} }));
  if (loaded.state === "failed") return <FailedAlert title="勤怠を読めませんでした" failure={loaded} />;
  if (people.state === "failed") return <FailedAlert title="社員を読めませんでした" failure={people} />;
  const staff = people.state === "ok" ? people.data : [];
  const grid = attendanceGrid(
    monthDays(month, today),
    staff.map((s) => s.id),
    loaded.state === "ok" ? loaded.data : [],
  );
  const rows: Record<string, string>[] = grid.days.map((d) => ({
    rowKey: d.day,
    day: dayLabel(d.day),
    ...Object.fromEntries(staff.map((s) => [s.id, cellText(d.cells[s.id])])),
  }));
  if (rows.length > 0) {
    rows.push({
      rowKey: "total",
      day: "合計",
      ...Object.fromEntries(
        staff.map((s) => {
          const t = grid.totals[s.id];
          return [s.id, t ? `${String(t.days)} 日 ${duration(Math.floor(t.workedMs / 60_000))}` : "なし"];
        }),
      ),
    });
  }
  return (
    <Table
      label="office 全体の勤怠"
      loading={loaded.state === "loading" || people.state === "loading"}
      rowKey={(r) => r.rowKey ?? ""}
      rows={rows}
      columns={[{ key: "day", header: "日" }, ...staff.map((s) => ({ key: s.id, header: s.role, numeric: true, wrap: true }))]}
      emptyTitle="データがありません"
      emptyText="この月の勤怠はまだ付いていません"
    />
  );
}
