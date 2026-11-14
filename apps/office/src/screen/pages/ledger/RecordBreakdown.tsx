// 記録の画面 (check.py が records のフォルダを断るので ledger に置く) の内訳。サービスか社員ごとの時間、タスク、費用、トークンと全体を入口から読み、グラフと CSV を出す (サービスと拡張の 3.4)
import type { RecordGroup, RecordSummary } from "@know-office/core";
import { Alert, Chart, Link, SegmentedControl, Stack, Table } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { duration } from "../../format.ts";

const Failure = z.object({ code: z.string(), traceId: z.string() }).loose();

type Failed = { state: "failed"; code: string; traceId: string | null };
type Loaded = { state: "loading" } | { state: "ok"; data: RecordSummary } | Failed;

/** 分け方ごとの名前。切り替え、表、グラフ、列の見出しに使う */
const GROUPS: Record<RecordGroup, { option: string; table: string; column: string }> = {
  service: { option: "サービスごと", table: "サービスごとの記録", column: "サービス" },
  staff: { option: "社員ごと", table: "社員ごとの記録", column: "社員" },
};

const isGroup = (v: string): v is RecordGroup => v === "service" || v === "staff";

/**
 * 期間を決めずに、分け方ごとの集計を入口から読む
 * @param group 分け方
 * @returns 読んでいる、読めた、読めなかった。入口を呼ぶ口が無ければ読めなかった
 */
function useRecordSummary(group: RecordGroup): Loaded {
  const api = useContext(ApiContext);
  // 読んだ物を、どの分け方の物かと一緒に持つ。分け方が変われば、読み終えるまで読んでいる事にする
  const [loaded, setLoaded] = useState<{ group: RecordGroup; value: Loaded } | null>(null);
  useEffect(() => {
    let live = true;
    void api?.api.v1.records.summary
      .$get({ query: { group } })
      .then(async (res): Promise<Loaded> => {
        if (res.ok) return { state: "ok", data: (await res.json()).data };
        // 返事は code で分け、不具合を伝えられるよう traceId を添える
        const body = Failure.safeParse(await res.json().catch(() => null));
        return body.success ? { state: "failed", code: body.data.code, traceId: body.data.traceId } : { state: "failed", code: String(res.status), traceId: null };
      })
      .catch((): Loaded => ({ state: "failed", code: "network", traceId: null }))
      .then((value) => {
        if (live) setLoaded({ group, value });
      });
    return () => {
      live = false;
    };
  }, [api, group]);
  // 入口を呼ぶ口が無ければ読みに行けないので、読んでいるままにしない
  if (!api) return { state: "failed", code: "network", traceId: null };
  return loaded?.group === group ? loaded.value : { state: "loading" };
}

/**
 * 100 万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.23 ドル」
 */
const dollars = (micro: number) => `${(micro / 1_000_000).toFixed(2)} ドル`;

/**
 * 読めた内訳の表とグラフと CSV。表の最後の行に全体を置く
 * @param props 集計
 * @param props.data 集計
 * @returns 内訳
 */
function Breakdown({ data }: { data: RecordSummary }) {
  const names = GROUPS[data.group];
  const rows = [...data.rows.map((r) => ({ ...r, rowKey: r.key })), { ...data.total, rowKey: "total", key: "total", name: "全体" }];
  return (
    <>
      <Chart
        ariaLabel={`${names.option}の掛けた時間`}
        unit="分"
        data={data.rows.map((r) => ({ key: r.key, label: r.name, value: Math.round(r.workedMs / 60_000) }))}
        state={data.rows.length === 0 ? "empty" : "ready"}
        emptyText="まだ記録が無い"
      />
      <Table
        label={names.table}
        rowKey={(r) => r.rowKey}
        rows={rows}
        columns={[
          { key: "name", header: names.column },
          { key: "workedMs", header: "掛けた時間", numeric: true, render: (r) => duration(Math.round(r.workedMs / 60_000)) },
          { key: "tasks", header: "終えたタスク", numeric: true, render: (r) => `${String(r.tasks)} 件` },
          { key: "costMicroUsd", header: "費用", numeric: true, render: (r) => dollars(r.costMicroUsd) },
          { key: "tokens", header: "トークン", numeric: true, render: (r) => r.tokens.toLocaleString("ja-JP") },
        ]}
      />
      <Link href={`/api/v1/records/summary/export?group=${data.group}`} download standalone>
        CSV で出す
      </Link>
    </>
  );
}

/**
 * 記録の内訳。サービスごとと社員ごとを切り替え、どちらも最後の行に全体を出す
 * @returns 内訳
 */
export function RecordBreakdown() {
  const [group, setGroup] = useState<RecordGroup>("service");
  const loaded = useRecordSummary(group);
  const names = GROUPS[group];
  let body;
  if (loaded.state === "loading") {
    body = <p role="status">{`${names.option}の記録を読んでいます`}</p>;
  } else if (loaded.state === "failed") {
    body = (
      <Alert tone="error" title="記録を読めませんでした" live>
        {loaded.code === "network" ? "入口につながりません。" : `理由: ${loaded.code}。`}
        {loaded.traceId ? ` 問い合わせの番号: ${loaded.traceId}` : null}
      </Alert>
    );
  } else {
    body = <Breakdown data={loaded.data} />;
  }
  return (
    <Stack gap={3}>
      <SegmentedControl
        label="内訳の分け方"
        value={group}
        onValueChange={(v) => {
          if (isGroup(v)) setGroup(v);
        }}
        options={Object.entries(GROUPS).map(([value, n]) => ({ value, label: n.option }))}
      />
      {body}
    </Stack>
  );
}
