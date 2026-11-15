// 記録の画面。office 全体の勤怠、仕事の数、サービスごとと社員ごとの内訳。内訳は入口から読み、勤怠と仕事の数は仮のデータ
import { Grid, Stat, Table } from "knowidea-ui";
import { duration } from "../../format.ts";
import { staff, workEntries } from "../../mock.ts";
import { Part, Section } from "../../parts/section.tsx";
import { useWorkTasks } from "../office/feed.ts";
import { RecordBreakdown } from "./RecordBreakdown.tsx";

export function RecordsPage() {
  const allTasks = useWorkTasks();
  const rows = staff.flatMap((s) =>
    (workEntries[s.id] ?? []).map((e) => ({ ...e, who: s.role, key: `${s.id}-${e.start}` })),
  );
  return (
    <Section>
      <Part title="勤怠">
        <Table
          label="office 全体の勤怠"
          rowKey={(r) => r.key}
          rows={rows}
          columns={[
            { key: "who", header: "社員" },
            { key: "start", header: "始めた", numeric: true },
            { key: "end", header: "終えた", numeric: true },
            { key: "task", header: "仕事", wrap: true },
            { key: "minutes", header: "掛かった", numeric: true, render: (r) => duration(r.minutes) },
          ]}
        />
      </Part>
      <Part title="仕事">
        <Grid minItemWidth={160}>
          {(["今", "可待ち", "次", "済"] as const).map((st) => (
            <Stat key={st} label={st} value={allTasks.filter((t) => t.state === st).length} unit="件" />
          ))}
        </Grid>
      </Part>
      <Part title="内訳">
        <RecordBreakdown />
      </Part>
    </Section>
  );
}
