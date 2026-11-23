// 1 つのサービスの詳細。段階を移す欄と、様子、元の案、記録、設定のタブ (サービスと拡張の 3.1 から 3.3)
import { labelOf } from "@know-office/core/master/master";
import { SERVICE_KINDS } from "@know-office/core/master/service-kinds";
import { SERVICE_STAGES } from "@know-office/core/master/service-stages";
import { NEXT_STAGES, ServiceDetail, ServiceStage, StaffId } from "@know-office/core";
import { Badge, Stack, Tabs, Timeline } from "knowidea-ui";
import { jstDateTime } from "../../format.ts";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { Part } from "../../parts/section.tsx";
import { STAFF_LABEL } from "../guard/labels.ts";
import { EVENT_LABEL, UNSET } from "./labels.ts";
import { IdeaEditor } from "./IdeaEditor.tsx";
import { ServiceIssuesView } from "./ServiceIssuesView.tsx";
import { ServiceSettings } from "./ServiceSettings.tsx";
import { ServiceStatusView } from "./ServiceStatusView.tsx";
import { StageActions } from "./StageActions.tsx";

/**
 * 出来事の detail を 1 行の文にする
 * @param event 出来事
 * @returns 文
 */
function eventText(event: ServiceDetail["events"][number]): string {
  const d = event.detail;
  const text = (key: string) => (typeof d[key] === "string" ? d[key] : null);
  if (event.kind === "stage") {
    const to = ServiceStage.safeParse(d["to"]);
    return [to.success ? `${labelOf(SERVICE_STAGES, to.data)}に移した` : "段階を移した", text("reason")].filter(Boolean).join("。");
  }
  if (event.kind === "rollback") return text("reason") ?? "";
  if (event.kind === "deploy" && typeof d["passed"] === "boolean") return d["passed"] ? "npm に公開できた" : "npm に公開できなかった";
  return text("version") ?? "";
}

/**
 * 出来事を起こした者の名前
 * @param by `owner`、社員 ID、`system`
 * @returns 名前
 */
function byLabel(by: string): string {
  const staff = StaffId.safeParse(by);
  if (staff.success) return STAFF_LABEL[staff.data];
  return by === "owner" ? "オーナー" : "自動";
}

export interface ServiceViewProps {
  /** サービス ID */
  serviceId: string;
  /** 読み直す数。一覧と一緒に読み直す */
  tick: number;
  /** 段階、リポジトリ、担当を変えた後に呼ぶ */
  onChanged: () => void;
}

/** サービスの詳細 */
export function ServiceView({ serviceId, tick, onChanged }: ServiceViewProps) {
  const loaded = useLoad(ServiceDetail, (a) => a.api.v1.services[":serviceId"].$get({ param: { serviceId } }), tick);
  if (loaded.state === "loading") return <p role="status">サービスを読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="サービスを読めませんでした" failure={loaded} />;
  const s = loaded.data;
  return (
    <Stack gap={4}>
      <Stack direction="row" gap={2} align="center" wrap>
        <h2>{s.name}</h2>
        <Badge>{labelOf(SERVICE_STAGES, s.stage)}</Badge>
        <Badge>{labelOf(SERVICE_KINDS, s.kind)}</Badge>
      </Stack>
      <p>
        リポジトリ: {s.repo ?? UNSET}、担当: {s.staffId === null ? UNSET : byLabel(s.staffId)}
      </p>
      {NEXT_STAGES[s.stage].length > 0 ? (
        <Part title="段階を移す">
          <StageActions key={s.stage} service={s} onMoved={onChanged} />
        </Part>
      ) : null}
      <Tabs
        label={`${s.name}の様子`}
        defaultValue="state"
        items={[
          { value: "state", label: "様子", content: <ServiceStatusView service={s} onChanged={onChanged} /> },
          { value: "issues", label: "Issue", content: <ServiceIssuesView serviceId={s.id} stage={s.stage} name={s.name} tick={tick} /> },
          { value: "idea", label: "元の案", content: <IdeaEditor service={s} onSaved={onChanged} /> },
          {
            value: "log",
            label: "記録",
            content: (
              <Timeline
                items={s.events.map((e, n) => ({ id: String(n), time: jstDateTime(e.at), title: EVENT_LABEL[e.kind] ?? e.kind, text: eventText(e), meta: byLabel(e.by), tone: e.kind === "rollback" ? "warn" : undefined }))}
                emptyText="データがありません"
              />
            ),
          },
          { value: "settings", label: "設定", content: <ServiceSettings serviceId={s.id} name={s.name} onChanged={onChanged} /> },
        ]}
      />
    </Stack>
  );
}
