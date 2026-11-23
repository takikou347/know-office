// 記録の画面の費用のタブの頭。選んだ月と累計の費用、12 か月の推移を、Claude API と Cloudflare の見込みに分けて出す (画面の全体の画面の一覧)
import { CostHistory, type CostMonth } from "@know-office/core";
import { Chart, Grid, Link, Stack, Stat, Table } from "knowidea-ui";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { monthLabel, recentMonths } from "./month.ts";

/** 推移に並べる月の数 */
const TREND_MONTHS = 12;

/**
 * 100 万分の 1 ドルを、セントまでのドルの数にする
 * @param micro 100 万分の 1 ドル
 * @returns 「1.23」
 */
const usd = (micro: number) => (micro / 1_000_000).toFixed(2);

/**
 * 内訳の文にする
 * @param m Claude API と Cloudflare の額
 * @returns 「Claude API 1.23 ドル、Cloudflare 5.00 ドル (見込み)」
 */
const split = (m: Pick<CostMonth, "claudeMicroUsd" | "cloudflareMicroUsd">) => `Claude API ${usd(m.claudeMicroUsd)} ドル、Cloudflare ${usd(m.cloudflareMicroUsd)} ドル (見込み)`;

export interface CostTrendProps {
  /** 見る月 YYYY-MM */
  month: string;
  /** 日本時間の今日 YYYY-MM-DD。推移は今月から前の 12 か月 */
  today: string;
  /** グラフの月を選んだ時に、見る月を替える */
  onMonthChange: (month: string) => void;
}

/**
 * 費用の推移と累計
 * @param props 月と今日と月を替える口
 * @returns 数字、グラフ、表、CSV
 */
export function CostTrend({ month, today, onMonthChange }: CostTrendProps) {
  const loaded = useLoad(CostHistory, (a) => a.api.v1.records.costs.$get());
  if (loaded.state === "failed") return <FailedAlert title="費用の推移を読めませんでした" failure={loaded} />;
  if (loaded.state === "loading") return <p role="status">費用の推移を読んでいます</p>;
  const history = loaded.data;
  const byMonth = new Map(history.months.map((m) => [m.month, m]));
  const picked = byMonth.get(month);
  // 推移は古い月から並べ、記録の無い月 (使い始める前) は 0 にする
  const trend = recentMonths(today, TREND_MONTHS)
    .toReversed()
    .map((m) => byMonth.get(m) ?? { month: m, claudeMicroUsd: 0, cloudflareMicroUsd: 0, totalMicroUsd: 0 });
  return (
    <Stack gap={4}>
      <Grid minItemWidth={240}>
        <Stat
          label={`${monthLabel(month)}の費用`}
          icon="chart-bar"
          value={picked ? usd(picked.totalMicroUsd) : "データがありません"}
          unit={picked ? "ドル" : undefined}
          sub={picked ? split(picked) : undefined}
        />
        <Stat label="累計の費用" icon="chart-bar" value={usd(history.totalMicroUsd)} unit="ドル" sub={split(history)} />
      </Grid>
      <Chart
        ariaLabel="月ごとの費用の推移"
        unit="ドル"
        selectedKey={month}
        onSelect={onMonthChange}
        data={trend.map((m) => ({ key: m.month, label: monthLabel(m.month), value: Number(usd(m.totalMicroUsd)) }))}
        state={trend.some((m) => m.totalMicroUsd > 0) ? "ready" : "empty"}
        emptyText="データがありません"
      />
      <Table
        label="月ごとの費用"
        rowKey={(r) => r.month}
        rows={trend.toReversed()}
        columns={[
          { key: "month", header: "月", render: (r) => monthLabel(r.month) },
          { key: "claudeMicroUsd", header: "Claude API", numeric: true, render: (r) => `${usd(r.claudeMicroUsd)} ドル` },
          { key: "cloudflareMicroUsd", header: "Cloudflare (見込み)", numeric: true, render: (r) => `${usd(r.cloudflareMicroUsd)} ドル` },
          { key: "totalMicroUsd", header: "合計", numeric: true, render: (r) => `${usd(r.totalMicroUsd)} ドル` },
        ]}
      />
      <Link href="/api/v1/records/costs/export" download standalone>
        月ごとの費用を CSV で出す
      </Link>
    </Stack>
  );
}
