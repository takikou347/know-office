// 社員とタスクの画面の勤怠の表。1 日の勤怠を入口から読み、上の 1 行とタスク 1 件 1 行の表を出す (社員と勤怠の 3.7)
import { type DayAttendance, jstDay, StaffId, systemClock } from "@know-office/core";
import { Alert, Stack, Table } from "knowidea-ui";
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
  /** 日本時間の日 YYYY-MM-DD。無ければ今日 */
  day?: string | null;
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
 * 1 日の勤怠の表。上の 1 行に出勤から止められていた時間まで、表にタスク 1 件 1 行。幅が狭い時は 3 列にし、行を開くと残りを出す
 * @param props 社員と日
 * @returns 勤怠の表
 */
export function AttendanceTable({ staffId, role, day }: AttendanceTableProps) {
  const shown = day && z.iso.date().safeParse(day).success ? day : jstDay(systemClock.now());
  const loaded = useDayAttendance(staffId, shown);
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
            { key: "start", header: "始めた", numeric: true },
            { key: "end", header: "終えた", numeric: true },
            {
              key: "task",
              header: "仕事",
              wrap: true,
              render: (r) => (
                <>
                  <span className="ko-wide">{r.task}</span>
                  <details className="ko-narrow">
                    <summary>{r.task}</summary>
                    <p>
                      掛かった {duration(r.minutes)}、{r.service}、{r.result}
                    </p>
                  </details>
                </>
              ),
            },
            { key: "minutes", header: "掛かった", numeric: true, render: (r) => duration(r.minutes) },
            { key: "service", header: "サービス" },
            { key: "result", header: "結果", wrap: true },
          ]}
          emptyText="この日の仕事はまだ無い"
        />
      </div>
    </Stack>
  );
}
