// 記録の画面 (check.py が records のフォルダを断るので ledger に置く) のサービスごとの内訳。office とサービスごとの時間、タスク、費用、トークンと全体を入口から読み、グラフと CSV を出す (サービスと拡張の 3.4)
import type { RecordSummary } from "@know-office/core";
import { Alert, Chart, Link, Stack, Table } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { duration } from "../../format.ts";

const Failure = z.object({ code: z.string(), traceId: z.string() }).loose();

type Loaded = { state: "loading" } | { state: "ok"; data: RecordSummary } | { state: "failed"; code: string; traceId: string | null };

const CSV_PATH = "/api/v1/records/summary/export?group=service";

/**
 * 期間を決めずに、サービスごとの集計を入口から読む
 * @returns 読んでいる、読めた、読めなかった
 */
function useServiceSummary(): Loaded {
  const api = useContext(ApiContext);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let live = true;
    if (api) {
      void api.api.v1.records.summary
        .$get({ query: { group: "service" } })
        .then(async (res): Promise<Loaded> => {
          if (res.ok) return { state: "ok", data: (await res.json()).data };
          // 返事は code で分け、不具合を伝えられるよう traceId を添える
          const body = Failure.safeParse(await res.json().catch(() => null));
          return body.success ? { state: "failed", code: body.data.code, traceId: body.data.traceId } : { state: "failed", code: String(res.status), traceId: null };
        })
        .catch((): Loaded => ({ state: "failed", code: "network", traceId: null }))
        .then((value) => {
          if (live) setLoaded(value);
        });
    }
    return () => {
      live = false;
    };
  }, [api]);
  return loaded;
}

/**
 * 100 万分の 1 ドルを、セントまでのドルの文にする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.23 ドル」
 */
const dollars = (micro: number) => `${(micro / 1_000_000).toFixed(2)} ドル`;

/**
 * サービスごとの内訳の表とグラフ。最後の行に全体を置く
 * @returns 内訳
 */
export function ServiceSummary() {
  const loaded = useServiceSummary();
  if (loaded.state === "loading") return <p>サービスごとの記録を読んでいます</p>;
  if (loaded.state === "failed") {
    return (
      <Alert tone="error" title="サービスごとの記録を読めませんでした">
        {loaded.code === "network" ? "入口につながりません。" : `理由: ${loaded.code}。`}
        {loaded.traceId ? ` 問い合わせの番号: ${loaded.traceId}` : null}
      </Alert>
    );
  }
  const { rows, total } = loaded.data;
  const table = [...rows.map((r) => ({ ...r, rowKey: r.key })), { ...total, rowKey: "total", key: "total", name: "全体" }];
  return (
    <Stack gap={3}>
      <Chart
        ariaLabel="サービスごとの掛けた時間"
        unit="分"
        data={rows.map((r) => ({ key: r.key, label: r.name, value: Math.round(r.workedMs / 60_000) }))}
        state={rows.length === 0 ? "empty" : "ready"}
        emptyText="まだ記録が無い"
      />
      <Table
        label="サービスごとの記録"
        rowKey={(r) => r.rowKey}
        rows={table}
        columns={[
          { key: "name", header: "サービス" },
          { key: "workedMs", header: "掛けた時間", numeric: true, render: (r) => duration(Math.round(r.workedMs / 60_000)) },
          { key: "tasks", header: "終えたタスク", numeric: true, render: (r) => `${String(r.tasks)} 件` },
          { key: "costMicroUsd", header: "費用", numeric: true, render: (r) => dollars(r.costMicroUsd) },
          { key: "tokens", header: "トークン", numeric: true, render: (r) => r.tokens.toLocaleString("ja-JP") },
        ]}
      />
      <Link href={CSV_PATH} download standalone>
        CSV で出す
      </Link>
    </Stack>
  );
}
