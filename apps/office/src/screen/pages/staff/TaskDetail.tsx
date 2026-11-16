// 仕事の山とタスクの詳細。社員のタスクを入口から読んで並べ、開いたタスクは出来事の流れと、レビューがあればレビューを出す (タスクとレビューの 3.6)
import { NodeDetail, NodeTree, type StaffOverview } from "@know-office/core";
import { List, Stack, Status, Timeline } from "knowidea-ui";
import { useEffect } from "react";
import { z } from "zod";
import { jstDateTime } from "../../format.ts";
import { useLiveTick } from "../../parts/live.tsx";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { Part } from "../../parts/section.tsx";
import { NODE_STATUSES, taskHref } from "../../parts/tasks.ts";
import { knowNode, reviewDecided } from "../office/feed.ts";
import { ReviewPage } from "./ReviewPage.tsx";

/** 1 度に読むタスクの数 */
const TASK_PAGE = "100";

export interface TaskPileProps {
  /** 担当の社員 */
  staff: StaffOverview;
}

/**
 * 社員の仕事の山。木にせず ID の順に並べ、タスクが変わった印で読み直す
 * @param props 担当の社員
 * @returns 一覧
 */
export function TaskPile({ staff }: TaskPileProps) {
  const tick = useLiveTick((e) => e.type === "node");
  const loaded = useLoad(z.array(NodeTree), (a) => a.api.v1.nodes.$get({ query: { assignee: staff.id, limit: TASK_PAGE } }), tick);
  if (loaded.state === "failed") return <FailedAlert title="仕事を読めませんでした" failure={loaded} />;
  const tasks = loaded.state === "ok" ? loaded.data : [];
  return (
    <List
      label={`${staff.role}の仕事`}
      state={loaded.state === "loading" ? "loading" : (tasks.length === 0 ? "empty" : "ready")}
      loadingText="仕事を読んでいます"
      emptyText="仕事は無い"
      items={tasks.map((t) => ({
        id: t.id,
        title: t.title,
        href: taskHref(staff.id, t.id),
        meta: <Status kind={NODE_STATUSES[t.status].kind} label={NODE_STATUSES[t.status].label} />,
      }))}
    />
  );
}

export interface TaskDetailProps {
  /** 担当の社員 ID */
  staffId: string;
  /** タスク ID */
  nodeId: string;
}

/**
 * タスクの詳細。題と状態、出来事の流れ、レビューを出す
 * @param props 社員とタスク
 * @returns 詳細
 */
export function TaskDetail({ staffId, nodeId }: TaskDetailProps) {
  const tick = useLiveTick((e) => e.type === "node" && e.node.id === nodeId);
  const loaded = useLoad(NodeDetail, (a) => a.api.v1.nodes[":nodeId"].$get({ param: { nodeId } }), tick);
  const node = loaded.state === "ok" ? loaded.data : null;
  useEffect(() => {
    if (node) knowNode(node);
  }, [node]);
  // レビューはレビュー待ちか、レビューの出来事があるタスクにだけある。読めない時はレビューの側で読み直す
  const hasReview = node === null || node.status === "review" || node.events.some((e) => e.kind.includes("review"));
  return (
    <Stack gap={4}>
      {node ? (
        <>
          <h2>{node.title}</h2>
          <Status kind={NODE_STATUSES[node.status].kind} label={NODE_STATUSES[node.status].label} />
          <Part title="作業の流れ">
            <Timeline items={node.events.toReversed().map((e, i) => ({ id: String(i), time: jstDateTime(e.at), title: e.kind, text: e.staffId ?? "オーナー" }))} emptyText="流れはまだ無い" />
          </Part>
        </>
      ) : null}
      {loaded.state === "loading" ? <p role="status">タスクを読んでいます</p> : null}
      {loaded.state === "failed" ? <FailedAlert title="タスクを読めませんでした" failure={loaded} /> : null}
      {hasReview ? <ReviewPage key={nodeId} nodeId={nodeId} staffId={staffId} onVerdict={(v) => reviewDecided(nodeId, v)} /> : null}
    </Stack>
  );
}
