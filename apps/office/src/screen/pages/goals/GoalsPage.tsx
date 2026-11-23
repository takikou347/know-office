// 目標の画面。目標を進み具合と期限のカードで並べ、開くとタスクを未着手、進行中、レビュー、完了の 4 列で見せる。目標とタスクを足し、変える (タスクとレビューの 3.1)
import { jstDay, NodeTree, OrgStaff, systemClock } from "@know-office/core";
import { labelOf } from "@know-office/core/master/master";
import { TASK_STATUSES } from "@know-office/core/master/task-statuses";
import { Alert, Badge, Card, EmptyState, Field, Grid, Link, Progress, Select, Stack } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { type Loaded, FailedAlert, useLoad } from "../../parts/load.tsx";
import type { Navigate } from "../../parts/navigate.ts";
import { Part } from "../../parts/section.tsx";
import { taskHref } from "../../parts/tasks.ts";
import { AddGoal, ChangeGoal } from "./GoalDialogs.tsx";
import { boardOf, dueOf, goalCards } from "./model.ts";
import { AddTask, ChangeTask, projectsOf, roleOf } from "./TaskDialogs.tsx";

/** 絞らない時の選ぶ欄の値 */
const ALL = "all";

/**
 * 期限の印。期限が無ければ出さない
 * @param props 期限の日と今日
 * @param props.dueDay 期限の日
 * @param props.today 今日
 * @param props.done 済んだか。済んだ物は期限切れにしない
 * @returns 期限の印
 */
function DueBadge({ dueDay, today, done }: { dueDay: string | null; today: string; done: boolean }) {
  const due = dueOf(dueDay, today, done);
  return due ? <Badge tone={due.tone}>{due.text}</Badge> : null;
}

/**
 * 進み具合の名前。目に見えるのは「進み具合」だけにし、読み上げには目標の名前を添える
 * @param props 目標の名前
 * @param props.title 目標の名前
 * @returns 進み具合の名前
 */
function ProgressLabel({ title }: { title: string }) {
  return (
    <>
      <span className="ki-sr-only">{title}の進み具合</span>
      <span aria-hidden="true">進み具合</span>
    </>
  );
}

/** 木を読み直す口と、ほかで先に変わっていた時の口 */
type Reload = {
  /** 変えた後に木を読み直す */
  reload: () => void;
  /** ほかで先に変わっていた時に、知らせを出して木を読み直す */
  conflicted: () => void;
};

interface GoalListProps {
  /** 木の根 */
  trees: NodeTree[];
  /** 今日 (YYYY-MM-DD) */
  today: string;
  /** 目標を足した後に呼ぶ */
  added: (goalId: string) => void;
  /** 目的だけを作れた時に、木を読み直す */
  reload: () => void;
}

/**
 * 目標の一覧。目的で絞り、目標をカードで並べる
 * @param props 木の根、今日、足した後と目的だけを作れた時に呼ぶ口
 * @returns 目標の一覧
 */
function GoalList({ trees, today, added, reload }: GoalListProps) {
  const [purpose, setPurpose] = useState(ALL);
  const purposes = trees.filter((t) => t.kind === "purpose");
  const cards = goalCards(trees, purpose === ALL ? null : purpose);
  return (
    <Stack gap={4}>
      <Stack direction="row" justify="between" align="end" wrap gap={3}>
        <Field label="目的で絞る">
          <Select aria-label="目的で絞る" value={purpose} options={[{ value: ALL, label: "すべての目的" }, ...purposes.map((p) => ({ value: p.id, label: p.title }))]} onValueChange={(v) => setPurpose(v ?? ALL)} />
        </Field>
        <AddGoal purposes={purposes} onDone={added} onCreated={reload} />
      </Stack>
      {cards.length === 0 ? (
        <EmptyState title="目標のデータがありません">「目標を足す」から、目標と期限を置きます。</EmptyState>
      ) : (
        <Grid minItemWidth={280} gap={4}>
          {cards.map((c) => (
            <Card
              key={c.goal.id}
              title={c.goal.title}
              href={`/goals/${c.goal.id}`}
              subtitle={c.purpose ? `目的: ${c.purpose.title}` : "オーナーの発言と Issue の受け付け"}
              badge={<DueBadge dueDay={c.goal.dueDay} today={today} done={c.goal.progress >= 1} />}
            >
              <Stack gap={2}>
                <Progress label={<ProgressLabel title={c.goal.title} />} value={Math.round(c.goal.progress * 100)} max={100} showValue />
                <p>
                  タスク {c.tasks} 件のうち {c.done} 件が完了
                </p>
              </Stack>
            </Card>
          ))}
        </Grid>
      )}
    </Stack>
  );
}

interface GoalBoardProps {
  /** 開いた目標か、受け付けのプロジェクト */
  goal: NodeTree;
  /** 目標の親の目的 */
  purpose: NodeTree | null;
  /** 頼む先に選べる社員 */
  staff: OrgStaff[];
  /** 社員を読んでいるか */
  staffLoading: boolean;
  /** 今日 (YYYY-MM-DD) */
  today: string;
  /** 読み直す口 */
  edit: Reload;
}

/**
 * 開いた目標。進み具合と期限、タスクを足すボタン、状態の 4 列のタスク
 * @param props 目標、目的、社員とその読み具合、今日、読み直す口
 * @returns 目標の中身
 */
function GoalBoard({ goal, purpose, staff, staffLoading, today, edit }: GoalBoardProps) {
  const [project, setProject] = useState(ALL);
  const projects = projectsOf(goal);
  const columns = boardOf(goal, project === ALL ? null : project);
  return (
    <Part title={goal.title}>
      <Stack gap={4}>
        <Stack direction="row" gap={2} wrap align="center">
          {purpose ? <span>目的: {purpose.title}</span> : <span>オーナーの発言と Issue の受け付け</span>}
          <DueBadge dueDay={goal.dueDay} today={today} done={goal.progress >= 1} />
        </Stack>
        <Progress label={<ProgressLabel title={goal.title} />} value={Math.round(goal.progress * 100)} max={100} showValue />
        <Stack direction="row" justify="between" align="end" wrap gap={3}>
          {projects.length > 1 ? (
            <Field label="プロジェクトで絞る">
              <Select aria-label="プロジェクトで絞る" value={project} options={[{ value: ALL, label: "すべてのプロジェクト" }, ...projects.map((p) => ({ value: p.id, label: p.title }))]} onValueChange={(v) => setProject(v ?? ALL)} />
            </Field>
          ) : (
            <span />
          )}
          <Stack direction="row" gap={2} wrap>
            {goal.kind === "goal" ? <ChangeGoal key={goal.version} goal={goal} onDone={edit.reload} onConflict={edit.conflicted} /> : null}
            <AddTask key={`${goal.id}-${String(projects.length)}`} goal={goal} staff={staff} staffLoading={staffLoading} onDone={edit.reload} onCreated={edit.reload} />
          </Stack>
        </Stack>
        <Grid columns={4} gap={3}>
          {columns.map((col) => (
            <Stack as="section" key={col.label} gap={2} aria-label={col.label}>
              <h3>
                {col.label} <Badge numeric>{col.tasks.length}</Badge>
              </h3>
              {col.tasks.length === 0 ? <p>データがありません</p> : null}
              {col.tasks.map(({ task, project: p }) => (
                <Card
                  key={task.id}
                  headingLevel={4}
                  title={task.title}
                  href={task.assignee === null ? undefined : taskHref(task.assignee, task.id)}
                  subtitle={p.id === goal.id ? undefined : p.title}
                  badge={task.status === "stopped" || task.status === "waiting_owner" ? <Badge tone="warn">{labelOf(TASK_STATUSES, task.status)}</Badge> : <DueBadge dueDay={task.dueDay} today={today} done={task.status === "done"} />}
                  meta={[{ label: "頼む先", value: roleOf(staff, task.assignee) }]}
                  actions={<ChangeTask key={task.version} task={task} staff={staff} staffLoading={staffLoading} onDone={edit.reload} onConflict={edit.conflicted} />}
                />
              ))}
            </Stack>
          ))}
        </Grid>
      </Stack>
    </Part>
  );
}

/**
 * 木の中から目標か受け付けのプロジェクトを ID で探す
 * @param trees 木の根
 * @param id 目標の ID
 * @returns 目標と親の目的。無ければ null
 */
function findGoal(trees: NodeTree[], id: string): { goal: NodeTree; purpose: NodeTree | null } | null {
  return goalCards(trees).find((c) => c.goal.id === id) ?? null;
}

export interface GoalsPageProps {
  /** 今の道。`/goals/<目標 ID>` なら目標を開く */
  pathname: string;
  /** 道を移す */
  navigate: Navigate;
}

/** 目標の画面 */
export function GoalsPage({ pathname, navigate }: GoalsPageProps) {
  const id = z.uuid().safeParse(pathname.split("/")[2]);
  const [tick, setTick] = useState(0);
  const [stale, setStale] = useState(false);
  const trees: Loaded<NodeTree[]> = useLoad(z.array(NodeTree), (a) => a.api.v1.nodes.$get({ query: { scope: "office", limit: "100" } }), tick);
  const org = useLoad(z.array(OrgStaff), (a) => a.api.v1.org.$get({ query: {} }));
  const [today] = useState(() => jstDay(systemClock.now()));
  const edit: Reload = {
    reload: () => {
      setStale(false);
      setTick((t) => t + 1);
    },
    conflicted: () => {
      setStale(true);
      setTick((t) => t + 1);
    },
  };

  let body = <p role="status">目標を読んでいます</p>;
  if (trees.state === "failed") body = <FailedAlert title="目標を読めませんでした" failure={trees} />;
  if (trees.state === "ok" && !id.success) {
    body = (
      <GoalList
        trees={trees.data}
        today={today}
        reload={edit.reload}
        added={(goalId) => {
          edit.reload();
          navigate(`/goals/${goalId}`);
        }}
      />
    );
  }
  if (trees.state === "ok" && id.success) {
    const found = findGoal(trees.data, id.data);
    body = found ? (
      <Stack gap={4}>
        {org.state === "failed" ? <FailedAlert title="社員を読めませんでした。頼む先を選べません" failure={org} /> : null}
        <GoalBoard goal={found.goal} purpose={found.purpose} staff={org.state === "ok" ? org.data : []} staffLoading={org.state === "loading"} today={today} edit={edit} />
      </Stack>
    ) : (
      <EmptyState title="目標が見つかりません">取り消されたか、まだ読めていません。</EmptyState>
    );
  }

  return (
    <Stack gap={4}>
      {id.success ? (
        <div>
          <Link href="/goals">目標の一覧へ戻る</Link>
        </div>
      ) : null}
      {stale ? (
        <Alert tone="warn" live onClose={() => setStale(false)} closeLabel="知らせを閉じる">
          ほかで先に変わっていたので読み直しました。今の頼む先と期限を確かめてから、もう一度変えてください。
        </Alert>
      ) : null}
      {body}
    </Stack>
  );
}
