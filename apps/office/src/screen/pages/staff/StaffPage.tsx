// 社員と仕事の画面。社員の一覧を入口から読み、会話と仕事の山と勤怠のタブ、今日だけの指示、タスクの詳細とレビューを 1 つの一覧と詳細に並べる (社員と勤怠の 3.4、社員と自動の 3.7)
import { StaffOverview } from "@know-office/core";
import { EmptyState, List, ListDetail, Stack, Tabs } from "knowidea-ui";
import { z } from "zod";
import { useLiveTick } from "../../parts/live.tsx";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import type { Navigate } from "../../parts/navigate.ts";
import { Part } from "../../parts/section.tsx";
import { StaffStatus } from "../../parts/staff-status.tsx";
import { AttendanceTable } from "./AttendanceTable.tsx";
import { DayOrders } from "./DayOrders.tsx";
import { Talk } from "./Talk.tsx";
import { TaskDetail, TaskPile } from "./TaskDetail.tsx";

const staffTabs = ["talk", "tasks", "attendance"] as const;
type StaffTab = (typeof staffTabs)[number];
const isStaffTab = (v: string | null): v is StaffTab => staffTabs.some((t) => t === v);

/**
 * 道の問いの tab から開くタブを決める。知らない値と無い時は会話
 * @param param 問いの tab
 * @returns 開くタブ
 */
export function staffTabOf(param: string | null): StaffTab {
  return isStaffTab(param) ? param : "talk";
}

interface StaffDetailProps {
  s: StaffOverview;
  tab: StaffTab;
  day: string | null;
  navigate: Navigate;
}

/**
 * 社員 1 人の様子。今の状態とタスク、今日だけの指示、会話と仕事の山と勤怠のタブ
 * @param props 社員、開くタブ、勤怠の日
 * @returns 様子
 */
function StaffDetail({ s, tab, day, navigate }: StaffDetailProps) {
  return (
    <Stack gap={4}>
      <Stack direction="row" gap={2} align="center" wrap>
        <h2>{s.role}</h2>
        <StaffStatus state={s.state} />
      </Stack>
      <p>{s.nodeTitle === null ? "今のタスクは無い" : `今のタスク: ${s.nodeTitle}`}</p>
      <Part title="今日だけの指示">
        <DayOrders key={s.id} staff={s} />
      </Part>
      <Tabs
        label={`${s.role}の様子`}
        value={tab}
        onValueChange={(v) => navigate(`/staff/${s.id}?tab=${v}`, { replace: true })}
        items={[
          { value: "talk", label: "会話", content: <Talk key={s.id} staff={s} /> },
          { value: "tasks", label: "仕事の山", content: <TaskPile key={s.id} staff={s} /> },
          { value: "attendance", label: "勤怠", content: <AttendanceTable staffId={s.id} role={s.role} day={day} /> },
        ]}
      />
    </Stack>
  );
}

export interface StaffPageProps {
  /** 道。/staff/<社員>/tasks/<タスク> ならタスクの詳細を開く */
  pathname: string;
  /** 道の問い。tab と day を読む */
  query: URLSearchParams;
  /** 画面の中を移る */
  navigate: Navigate;
}

/**
 * 社員と仕事の画面
 * @param props 道と問い
 * @returns 画面
 */
export function StaffPage({ pathname, query, navigate }: StaffPageProps) {
  const [, , id = "", , taskId = ""] = pathname.split("/");
  const tick = useLiveTick((e) => e.type === "staff");
  const loaded = useLoad(z.array(StaffOverview), (a) => a.api.v1.staff.$get({ query: {} }), tick);
  const people = loaded.state === "ok" ? loaded.data : [];
  const selected = people.find((s) => s.id === id);
  // タスク ID は UUID だけを受け、ほかは社員の様子を出す
  const inTask = selected !== undefined && z.uuid().safeParse(taskId).success;
  const tab = staffTabOf(query.get("tab"));
  const detail = (s: StaffOverview) => (inTask ? <TaskDetail key={taskId} staffId={s.id} nodeId={taskId} /> : <StaffDetail s={s} tab={tab} day={query.get("day")} navigate={navigate} />);
  return (
    <ListDetail
      listLabel="社員"
      detailLabel="社員の様子"
      showDetail={selected !== undefined}
      onBack={() => navigate(inTask && selected ? `/staff/${selected.id}?tab=tasks` : "/staff")}
      backLabel={inTask ? "仕事の山へ戻る" : "社員の一覧へ戻る"}
      list={
        loaded.state === "failed" ? (
          <FailedAlert title="社員を読めませんでした" failure={loaded} />
        ) : (
          <List
            label="社員"
            state={loaded.state === "loading" ? "loading" : "ready"}
            loadingText="社員を読んでいます"
            items={people.map((s) => ({
              id: s.id,
              title: s.role,
              href: `/staff/${s.id}`,
              meta: (
                <>
                  <StaffStatus state={s.state} /> {s.model}
                </>
              ),
            }))}
          />
        )
      }
      detail={selected ? detail(selected) : undefined}
      empty={<EmptyState title="社員を選ぶ">選ぶと、会話と仕事の山と勤怠が出ます</EmptyState>}
    />
  );
}
