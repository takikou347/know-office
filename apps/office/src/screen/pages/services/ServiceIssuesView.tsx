// サービスの Issue のタブ。親ごとに子の済みを出し、設計書の PR を並べ、試作で全部済んだらサービスに進められると知らせる (開発の回し方の 3.7)
import { ServiceIssues, type ServiceStage } from "@know-office/core";
import { Accordion, Alert, Badge, List, Stack } from "knowidea-ui";
import { FailedAlert, type Loaded, useLoad } from "../../parts/load.tsx";
import { NODE_STATUSES } from "../../parts/tasks.ts";

const KIND_TEXT = { bug: "バグ", feature: "機能", chore: "雑務" } as const;

export interface ServiceIssuesListProps {
  /** 読んだ木 */
  issues: ServiceIssues;
  /** サービスの段階。試作の時だけ、進められると知らせる */
  stage: ServiceStage;
  /** サービスの名前 */
  name: string;
}

/** 木を出す。読み込みは ServiceIssuesView が持つ */
export function ServiceIssuesList({ issues, stage, name }: ServiceIssuesListProps) {
  return (
    <Stack gap={4}>
      {issues.ready && stage === "prototype" ? (
        <Alert tone="success" title={`${name}をサービスに進められる`}>
          機能の Issue がすべて閉じた。上の「段階を移す」から、サービスに進める。
        </Alert>
      ) : null}
      {issues.parents.length === 0 ? (
        <p>Issue はまだ無い</p>
      ) : (
        <Accordion
          multiple
          defaultValue={issues.parents.map((p) => String(p.number))}
          items={issues.parents.map((p) => {
            const done = p.children.filter((c) => c.state === "closed").length;
            return {
              value: String(p.number),
              title: (
                <span>
                  {`${p.operations ? "運用" : p.feature} #${String(p.number)} ${String(done)} / ${String(p.children.length)} 済`} <Badge>{p.state === "closed" ? "閉じた" : "開いている"}</Badge>
                </span>
              ),
              content: (
                <List
                  label={`${p.operations ? "運用" : p.feature}の子 Issue`}
                  emptyText="子の Issue はまだ無い"
                  items={p.children.map((c) => ({
                    id: String(c.number),
                    title: `#${String(c.number)} ${c.requirement ?? ""}`,
                    meta: [c.kind === null ? null : KIND_TEXT[c.kind], c.state === "closed" ? "済" : "開いている", c.task === null ? null : NODE_STATUSES[c.task.status].label, c.task?.prNumber === undefined || c.task.prNumber === null ? null : `PR #${String(c.task.prNumber)}`].filter(Boolean).join("、"),
                  }))}
                />
              ),
            };
          })}
        />
      )}
      {issues.docsPrs.length === 0 ? null : (
        <List
          label="設計書の PR"
          summary="設計書の PR"
          items={issues.docsPrs.map((p) => ({ id: `${p.repo}#${String(p.number)}`, title: `${p.repo}#${String(p.number)}`, meta: [p.kind === "design" ? "設計書を書く" : "同じ時に直す", NODE_STATUSES[p.task.status].label].join("、") }))}
        />
      )}
    </Stack>
  );
}

export interface ServiceIssuesBodyProps {
  /** 読んだ結果 */
  loaded: Loaded<ServiceIssues>;
  /** サービスの段階 */
  stage: ServiceStage;
  /** サービスの名前 */
  name: string;
}

/** 読み込み中、読めなかった時、読めた時の出し分け */
export function ServiceIssuesBody({ loaded, stage, name }: ServiceIssuesBodyProps) {
  if (loaded.state === "loading") return <p role="status">Issue を読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="Issue を読めませんでした" failure={loaded} />;
  return <ServiceIssuesList issues={loaded.data} stage={stage} name={name} />;
}

export interface ServiceIssuesViewProps {
  /** サービス ID */
  serviceId: string;
  /** サービスの段階 */
  stage: ServiceStage;
  /** サービスの名前 */
  name: string;
  /** 読み直す数 */
  tick: number;
}

/** サービスの Issue のタブ */
export function ServiceIssuesView({ serviceId, stage, name, tick }: ServiceIssuesViewProps) {
  const loaded = useLoad(ServiceIssues, (a) => a.api.v1.services[":serviceId"].issues.$get({ param: { serviceId } }), tick);
  return <ServiceIssuesBody loaded={loaded} stage={stage} name={name} />;
}
