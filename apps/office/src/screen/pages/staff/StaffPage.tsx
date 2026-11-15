// 社員と仕事の画面。社員の一覧、会話と仕事の山と勤怠のタブ、仕事のレビューを 1 つの一覧と詳細に並べる。社員と仕事の山は仮のデータで、レビューは入口から読む
import { Button, Conversation, EmptyState, List, ListDetail, Stack, Status, Tabs } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { jstTime } from "../../format.ts";
import { type Staff, messages, staff } from "../../mock.ts";
import type { Navigate } from "../../parts/navigate.ts";
import { Done } from "../../parts/section.tsx";
import { StaffStatus } from "../../parts/staff-status.tsx";
import { TASK_KIND, reviewHref } from "../../parts/tasks.ts";
import { useWorkTasks } from "../office/feed.ts";
import { AttendanceTable } from "./AttendanceTable.tsx";
import { ReviewPage } from "./ReviewPage.tsx";
import { TaskReview } from "./TaskReview.tsx";

function DayOrders({ s }: { s: Staff }) {
  const [done, setDone] = useState<string>();
  return (
    <Stack gap={2}>
      <Stack direction="row" gap={2} wrap>
        <Button variant="secondary" onClick={() => setDone(`${s.role}に延長を伝えました`)}>
          延長する
        </Button>
        <Button variant="secondary" onClick={() => setDone(`${s.role}に早く終えるよう伝えました`)}>
          早く終える
        </Button>
        <Button variant="secondary" onClick={() => setDone(`${s.role}を今日は休みにしました`)}>
          休みにする
        </Button>
      </Stack>
      <Done text={done} />
    </Stack>
  );
}

const staffTabs = ["talk", "tasks", "attendance"] as const;
type StaffTab = (typeof staffTabs)[number];
const isStaffTab = (v: string | null): v is StaffTab => staffTabs.some((t) => t === v);

function StaffDetail({ s, tab, day, navigate }: { s: Staff; tab: StaffTab; day: string | null; navigate: Navigate }) {
  const mine = useWorkTasks().filter((t) => t.staffId === s.id);
  return (
    <Stack gap={4}>
      <Stack direction="row" gap={2} align="center" wrap>
        <h2>{s.role}</h2>
        <StaffStatus s={s} />
      </Stack>
      <p>{s.now}</p>
      <DayOrders s={s} />
      <Tabs
        label={`${s.role}の様子`}
        value={tab}
        onValueChange={(v) => navigate(`/staff/${s.id}?tab=${v}`, { replace: true })}
        items={[
          {
            value: "talk",
            label: "会話",
            content: (
              <Conversation
                label={`${s.role}との会話`}
                messages={(messages[s.id] ?? []).map((m) => ({ ...m, timeLabel: jstTime(m.time) }))}
                empty={<p>まだ話していない</p>}
              />
            ),
          },
          {
            value: "tasks",
            label: "仕事の山",
            content: (
              <List
                label={`${s.role}の仕事`}
                items={mine.map((t) => ({
                  id: t.id,
                  title: t.title,
                  href: reviewHref(t),
                  meta: (
                    <>
                      <Status kind={TASK_KIND[t.state]} label={t.state} /> {t.service}
                    </>
                  ),
                }))}
                emptyText="仕事は無い"
              />
            ),
          },
          { value: "attendance", label: "勤怠", content: <AttendanceTable staffId={s.id} role={s.role} day={day} /> },
        ]}
      />
    </Stack>
  );
}

export interface StaffPageProps {
  /** 道。/staff/<社員>/tasks/<タスク> ならレビューを開く */
  pathname: string;
  /** 道の問い。tab と day を読む */
  query: URLSearchParams;
  /** 画面の中を移る */
  navigate: Navigate;
}

/** 社員と仕事の画面 */
export function StaffPage({ pathname, query, navigate }: StaffPageProps) {
  const [, , id, , taskId = ""] = pathname.split("/");
  const selected = staff.find((s) => s.id === id);
  const task = useWorkTasks().find((t) => t.id === taskId && t.staffId === selected?.id);
  // 入口にあるレビューはタスク ID (UUID) で開く。仮のデータのタスクは画面の中だけのレビューを出す
  const reviewId = selected && !task && z.uuid().safeParse(taskId).success ? taskId : null;
  const tabParam = query.get("tab");
  const tab: StaffTab = isStaffTab(tabParam) ? tabParam : "talk";
  const inTask = Boolean(task) || reviewId !== null;
  const detail = (s: Staff) => {
    if (task) return <TaskReview key={task.id} task={task} />;
    if (reviewId !== null) return <ReviewPage key={reviewId} nodeId={reviewId} staffId={s.id} />;
    return <StaffDetail s={s} tab={tab} day={query.get("day")} navigate={navigate} />;
  };
  return (
    <ListDetail
      listLabel="社員"
      detailLabel="社員の様子"
      showDetail={Boolean(selected)}
      onBack={() => navigate(inTask && selected ? `/staff/${selected.id}?tab=tasks` : "/staff")}
      backLabel={inTask ? "仕事の山へ戻る" : "社員の一覧へ戻る"}
      list={
        <List
          label="社員"
          items={staff.map((s) => ({
            id: s.id,
            title: s.role,
            href: `/staff/${s.id}`,
            meta: (
              <>
                <StaffStatus s={s} /> {s.model}
              </>
            ),
          }))}
        />
      }
      detail={selected ? detail(selected) : undefined}
      empty={<EmptyState title="社員を選ぶ">選ぶと、会話と仕事の山と勤怠が出ます</EmptyState>}
    />
  );
}
