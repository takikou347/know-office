// 社員とタスクの画面の勤怠の表。日付をカレンダーで選び、その日の勤怠を入口から読み、上の 1 行とタスク 1 件 1 行の表を出す (社員と勤怠の 3.7)
import { type DayAttendance, jstDay, StaffId, systemClock } from "@know-office/core";
import { Alert, DatePicker, Field, Stack, Table } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { daySummaryText, duration, workEntryRow } from "../../format.ts";

const Failure = z.object({ code: z.string(), traceId: z.string() }).loose();

type Loaded = { state: "loading" } | { state: "ok"; data: DayAttendance } | { state: "failed"; code: string; traceId: string | null };

export interface AttendanceTableProps {
  /** 社員 ID。役割ごとに固定 */
  staffId: string;
  /** 社員の役の名前。表の名前に使う */
  role: string;
  /** 最初に開く日本時間の日 YYYY-MM-DD。無ければ今日 */
  day?: string | null;
}

/**
 * 日本時間の日 YYYY-MM-DD を、カレンダーが使うその日の 0 時の Date にする
 * @param day 日本時間の日
 * @returns カレンダーの日
 */
function calendarDate(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

/**
 * カレンダーで選んだ日を日本時間の日 YYYY-MM-DD にする
 * @param d カレンダーの日
 * @returns 日本時間の日
 */
function isoDay(d: Date): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 1 日の勤怠を入口から読む
 * @param staffId 社員 ID
 * @param day 日本時間の日
 * @returns 読んでいる、読めた、読めなかった
 */
function useDayAttendance(staffId: string, day: string): Loaded {
  const api = useContext(ApiContext);
  // 読んだ物を、どの社員と日の物かと一緒に持つ。社員か日が変われば、読み終えるまで読んでいる事にする
  const key = `${staffId}/${day}`;
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded }>({ key: "", value: { state: "loading" } });
  useEffect(() => {
    let live = true;
    const id = StaffId.safeParse(staffId);
    if (api && id.success) {
      void api.api.v1.staff[":staffId"].attendance
        .$get({ param: { staffId: id.data }, query: { day } })
        .then(async (res): Promise<Loaded> => {
          if (res.ok) return { state: "ok", data: (await res.json()).data };
          // 返事は code で分け、不具合を伝えられるよう traceId を添える
          const body = Failure.safeParse(await res.json().catch(() => null));
          return body.success ? { state: "failed", code: body.data.code, traceId: body.data.traceId } : { state: "failed", code: String(res.status), traceId: null };
        })
        .catch((): Loaded => ({ state: "failed", code: "network", traceId: null }))
        .then((value) => {
          if (live) setLoaded({ key: `${staffId}/${day}`, value });
        });
    }
    return () => {
      live = false;
    };
  }, [api, staffId, day]);
  return loaded.key === key ? loaded.value : { state: "loading" };
}

/**
 * 1 日の勤怠。上に日付を選ぶ欄、その下に勤怠の表を出す。選べるのは今日まで
 * @param props 社員と最初に開く日
 * @returns 日付の欄と勤怠の表
 */
export function AttendanceTable({ staffId, role, day }: AttendanceTableProps) {
  const today = jstDay(systemClock.now());
  // カレンダーで選んだ日は、どの道の日の上で選んだかと一緒に持つ。道の日が替われば選んだ日を捨て、道の日に従う
  const [picked, setPicked] = useState<{ from: string | null | undefined; day: string } | null>(null);
  const fromPath = day && z.iso.date().safeParse(day).success ? day : today;
  // 先の日は勤怠が無く、カレンダーの選べる範囲も今日までなので、今日に丸める
  const shown = picked && picked.from === day ? picked.day : (fromPath > today ? today : fromPath);
  return (
    <Stack gap={3}>
      <Field label="日付">
        <DatePicker
          aria-label="日付"
          value={calendarDate(shown)}
          max={calendarDate(today)}
          onValueChange={(d) => {
            if (d) setPicked({ from: day, day: isoDay(d) });
          }}
        />
      </Field>
      <DayAttendanceView staffId={staffId} role={role} day={shown} />
    </Stack>
  );
}

interface DayAttendanceViewProps {
  /** 社員 ID */
  staffId: string;
  /** 社員の役の名前。表の名前に使う */
  role: string;
  /** 日本時間の日 YYYY-MM-DD */
  day: string;
}

/**
 * 1 日の勤怠の表。上の 1 行に出勤から止められていた時間まで、表にタスク 1 件 1 行。幅が狭い時は 3 列にし、行を開くと残りを出す
 * @param props 社員と日
 * @returns 勤怠の表
 */
function DayAttendanceView({ staffId, role, day }: DayAttendanceViewProps) {
  const loaded = useDayAttendance(staffId, day);
  if (loaded.state === "loading") return <p>勤怠を読んでいます</p>;
  if (loaded.state === "failed") {
    return (
      <Alert tone="error" title="勤怠を読めませんでした">
        {loaded.code === "network" ? "入口につながりません。" : `理由: ${loaded.code}。`}
        {loaded.traceId ? ` 問い合わせの番号: ${loaded.traceId}` : null}
      </Alert>
    );
  }
  const { summary, entries } = loaded.data;
  return (
    <Stack gap={3}>
      <p>{daySummaryText(summary)}</p>
      <div className="ko-attendance">
        <Table
          label={`${role}の勤怠`}
          rowKey={(r) => r.key}
          rows={entries.map(workEntryRow)}
          columns={[
            { key: "start", header: "開始", numeric: true },
            { key: "end", header: "終了", numeric: true },
            {
              key: "task",
              header: "タスク",
              wrap: true,
              render: (r) => (
                <>
                  <span className="ko-wide">{r.task}</span>
                  <details className="ko-narrow">
                    <summary>{r.task}</summary>
                    <p>
                      所要時間 {duration(r.minutes)}、{r.service}、{r.result}
                    </p>
                  </details>
                </>
              ),
            },
            { key: "minutes", header: "所要時間", numeric: true, render: (r) => duration(r.minutes) },
            { key: "service", header: "サービス" },
            { key: "result", header: "結果", wrap: true },
          ]}
          emptyText="この日のタスクはありません"
        />
      </div>
    </Stack>
  );
}
