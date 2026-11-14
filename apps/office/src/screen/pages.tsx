// 8 画面と「その他」の中身。勤怠の表と目的と組織図のほかはモックの仮のデータで、押した操作は画面の中だけで変わり、記録には残らない。手で止めるボタンだけはゲートウェイを呼ぶ
import type { Health } from "@know-office/core";
import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Conversation,
  DiffView,
  EmptyState,
  Grid,
  Link,
  List,
  ListDetail,
  Stack,
  Stat,
  Status,
  type StatusKind,
  Table,
  Tabs,
  Timeline,
  parseUnifiedDiff,
} from "knowidea-ui";
import { type ReactNode, Suspense, lazy, useState } from "react";
import { duration, jstTime } from "./format.ts";
import {
  type Staff,
  type Task,
  extensions,
  flows,
  guardRules,
  ideas,
  lessons,
  messages,
  monthCost,
  notices,
  serviceLog,
  sessions,
  staff,
  stages,
  stops,
  tasks,
  usage,
  workEntries,
} from "./mock.ts";
import { GoalsPage } from "./pages/goals/GoalsPage.tsx";
import { StopButton } from "./pages/guard/StopButton.tsx";
import { AttendanceTable } from "./pages/staff/AttendanceTable.tsx";
import { type ScreenId, moreScreens } from "./routes.ts";

export type Navigate = (to: string, opts?: { replace?: boolean }) => void;

// エディタは「直す」を押した時だけ読み込む
const CodeEditor = lazy(() => import("knowidea-ui/editor").then((m) => ({ default: m.CodeEditor })));

const stateOf: Record<Staff["state"], { kind: StatusKind; label: string }> = {
  working: { kind: "working", label: "働いている" },
  paused: { kind: "paused", label: "待っている" },
  stopped: { kind: "stopped", label: "止めた" },
};

const taskKind: Record<Task["state"], StatusKind> = { 今: "working", 可待ち: "pending", 次: "neutral", 済: "success" };

const roleOf = (id: string) => staff.find((s) => s.id === id)?.role ?? id;

function StaffStatus({ s }: { s: Staff }) {
  const st = stateOf[s.state];
  return <Status kind={st.kind} label={st.label} />;
}

function Section({ children }: { children: ReactNode }) {
  return (
    <Container size="lg">
      <Stack gap={6} style={{ paddingBlock: "var(--space-5)" }}>
        {children}
      </Stack>
    </Container>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack as="section" gap={3}>
      <h2>{title}</h2>
      {children}
    </Stack>
  );
}

/** 押した事を知らせる帯。仮のデータなので記録しない事も添える */
function Done({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Alert tone="success" live>
      {text} (仮のデータなので記録しません)
    </Alert>
  );
}

const reviewHref = (t: Task) => `/staff/${t.staffId}/tasks/${t.id}`;

function Dashboard({ health }: { health?: Health }) {
  const working = staff.filter((s) => s.state === "working").length;
  const waiting = tasks.filter((t) => t.state === "可待ち");
  const today = tasks.filter((t) => t.state === "今");
  return (
    <Section>
      <p>{health ? "入口とつながりました" : "入口を確かめています"}</p>
      <Grid minItemWidth={200}>
        <Stat label="働いている社員" icon="users" value={working} unit="人" sub={`全体 ${staff.length}`} />
        <Stat label="可を待つ物" icon="flag" value={waiting.length} unit="件" />
        <Stat label="今月の費用" icon="chart-bar" value={monthCost.used} unit="ドル" sub={`見込み ${monthCost.budget} ドル`} />
      </Grid>
      <Part title="社員の様子">
        <Grid minItemWidth={260}>
          {staff.map((s) => (
            <Card key={s.id} title={s.role} subtitle={s.model} badge={<StaffStatus s={s} />} href={`/staff/${s.id}`}>
              {s.now}
            </Card>
          ))}
        </Grid>
      </Part>
      <Part title="可を待つ物">
        <List
          label="可を待つ物"
          items={waiting.map((t) => ({ id: t.id, title: t.title, href: reviewHref(t), meta: `${roleOf(t.staffId)}、${t.service}` }))}
          emptyText="可を待つ物は無い"
        />
      </Part>
      <Part title="今日の仕事">
        <List
          label="今日の仕事"
          items={today.map((t) => ({
            id: t.id,
            title: t.title,
            href: `/staff/${t.staffId}?tab=tasks`,
            meta: `${roleOf(t.staffId)}、${t.service}`,
          }))}
        />
      </Part>
      <Part title="お知らせ">
        <List label="お知らせ" items={notices.map((n) => ({ id: n.id, title: n.text, meta: n.time }))} />
      </Part>
    </Section>
  );
}

function TaskReview({ task }: { task: Task }) {
  const [done, setDone] = useState<string>();
  const [editing, setEditing] = useState(false);
  const files = task.diff ? parseUnifiedDiff(task.diff) : [];
  const first = files[0];
  const [text, setText] = useState(() =>
    (first?.hunks ?? []).flatMap((h) => h.lines.filter((l) => l.type !== "del").map((l) => l.text)).join("\n"),
  );
  return (
    <Stack gap={4}>
      <Link href={`/staff/${task.staffId}?tab=tasks`} standalone>
        仕事の山に戻る
      </Link>
      <h2>{task.title}</h2>
      <Stack direction="row" gap={2} align="center" wrap>
        <Status kind={taskKind[task.state]} label={task.state} />
        <span>
          {roleOf(task.staffId)}、{task.service}
        </span>
      </Stack>
      <Part title="作業の流れ">
        <Timeline items={flows[task.id] ?? []} emptyText="流れはまだ無い" />
      </Part>
      <Part title="変更">
        {files.length > 0 ? <DiffView files={files} /> : <p>変更はまだ無い</p>}
        {first && editing ? (
          <Suspense fallback={<p>エディタを読み込んでいます</p>}>
            <CodeEditor label={first.path} value={text} onChange={setText} language="typescript" />
          </Suspense>
        ) : null}
      </Part>
      <Done text={done} />
      <Stack direction="row" gap={2} wrap>
        <Button onClick={() => setDone("可を出しました")}>可</Button>
        <Button variant="secondary" onClick={() => setDone("不可を出し、作る役に戻しました")}>
          不可
        </Button>
        {first ? (
          <Button variant="quiet" onClick={() => setEditing((v) => !v)}>
            {editing ? "直すのをやめる" : "直す"}
          </Button>
        ) : null}
      </Stack>
    </Stack>
  );
}

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
  const mine = tasks.filter((t) => t.staffId === s.id);
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
                      <Status kind={taskKind[t.state]} label={t.state} /> {t.service}
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

function StaffAndTasks({ pathname, query, navigate }: { pathname: string; query: URLSearchParams; navigate: Navigate }) {
  const [, , id, , taskId] = pathname.split("/");
  const selected = staff.find((s) => s.id === id);
  const task = tasks.find((t) => t.id === taskId && t.staffId === selected?.id);
  const tabParam = query.get("tab");
  const tab: StaffTab = isStaffTab(tabParam) ? tabParam : "talk";
  return (
    <ListDetail
      listLabel="社員"
      detailLabel="社員の様子"
      showDetail={Boolean(selected)}
      onBack={() => navigate(task && selected ? `/staff/${selected.id}?tab=tasks` : "/staff")}
      backLabel={task ? "仕事の山へ戻る" : "社員の一覧へ戻る"}
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
      detail={
        selected ? (
          task ? (
            <TaskReview key={task.id} task={task} />
          ) : (
            <StaffDetail s={selected} tab={tab} day={query.get("day")} navigate={navigate} />
          )
        ) : undefined
      }
      empty={<EmptyState title="社員を選ぶ">選ぶと、会話と仕事の山と勤怠が出ます</EmptyState>}
    />
  );
}

function Goals() {
  return (
    <Section>
      <GoalsPage />
    </Section>
  );
}

function Office() {
  return (
    <Section>
      <EmptyState title="3D のオフィスは後で作る">今は社員の様子だけを出します。押すとその社員の会話が開きます</EmptyState>
      <Grid minItemWidth={220}>
        {staff.map((s) => (
          <Card key={s.id} title={s.role} headingLevel={2} badge={<StaffStatus s={s} />} href={`/staff/${s.id}`}>
            {s.now}
          </Card>
        ))}
      </Grid>
    </Section>
  );
}

function Services({ pathname, navigate }: { pathname: string; navigate: Navigate }) {
  const id = pathname.split("/")[2];
  const [added, setAdded] = useState<string[]>([]);
  const selected = ideas.find((i) => i.id === id);
  const list = (
    <Stack gap={4}>
      {stages.map((stage) => {
        const here = ideas.filter((i) => i.stage === stage);
        const extra = stage === "アイデア" ? added : [];
        return (
          <Part key={stage} title={stage}>
            <List
              label={stage}
              items={[
                ...here.map((i) => ({ id: i.id, title: i.title, href: `/services/${i.id}`, meta: i.summary })),
                ...extra.map((t, n) => ({ id: `new-${n}`, title: t, meta: "足した案" })),
              ]}
              emptyText="まだ無い"
            />
          </Part>
        );
      })}
      <Button variant="secondary" onClick={() => setAdded((a) => [...a, `新しい案 ${a.length + 1}`])}>
        案を足す
      </Button>
    </Stack>
  );
  return (
    <ListDetail
      listLabel="アイデアとサービス"
      detailLabel="サービスの様子"
      showDetail={Boolean(selected)}
      onBack={() => navigate("/services")}
      backLabel="一覧へ戻る"
      list={list}
      detail={
        selected ? (
          <Stack gap={4}>
            <Stack direction="row" gap={2} align="center" wrap>
              <h2>{selected.title}</h2>
              <Badge>{selected.stage}</Badge>
            </Stack>
            <Tabs
              label={`${selected.title}の様子`}
              defaultValue="state"
              items={[
                { value: "state", label: "様子", content: <p>{selected.summary}</p> },
                {
                  value: "log",
                  label: "記録",
                  content: (
                    <List
                      label={`${selected.title}の記録`}
                      items={(serviceLog[selected.id] ?? []).map((l, n) => ({ id: String(n), title: l.text, meta: l.time }))}
                      emptyText="記録はまだ無い"
                    />
                  ),
                },
                {
                  value: "settings",
                  label: "設定",
                  content: (
                    <List
                      label={`${selected.title}だけの設定`}
                      items={selected.settings.map((t, n) => ({ id: String(n), title: t }))}
                      emptyText="このサービスだけの設定は無い"
                    />
                  ),
                },
              ]}
            />
          </Stack>
        ) : undefined
      }
      empty={<EmptyState title="サービスを選ぶ">選ぶと、その様子と記録と設定が出ます</EmptyState>}
    />
  );
}

function Guard() {
  const [resumed, setResumed] = useState<string[]>([]);
  const [done, setDone] = useState<string>();
  const rows = stops.map((x) => ({ ...x, state: resumed.includes(x.id) ? "再開した" : x.state }));
  const stopped = rows.filter((x) => x.state === "止めている");
  return (
    <Section>
      <Part title="止めている物">
        {stopped.length === 0 ? <p>止めている物は無い</p> : null}
        {stopped.map((x) => (
          <Card
            key={x.id}
            title={x.target}
            subtitle={x.time}
            badge={<Status kind="stopped" label="止めている" />}
            actions={
              <Button
                aria-label={`${x.target}を再開する`}
                onClick={() => {
                  setResumed((r) => [...r, x.id]);
                  setDone(`${x.target}を再開しました`);
                }}
              >
                再開する
              </Button>
            }
          >
            {x.reason}
          </Card>
        ))}
        <Done text={done} />
      </Part>
      <Part title="止めた記録">
        <Table
          label="止めた記録"
          rowKey={(r) => r.id}
          rows={rows}
          columns={[
            { key: "time", header: "時刻", numeric: true },
            { key: "target", header: "相手" },
            { key: "reason", header: "理由", wrap: true },
            { key: "state", header: "今" },
          ]}
        />
      </Part>
      <Part title="基準">
        <ul>
          {guardRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Part>
      <Part title="蒸留した学び">
        <List label="蒸留した学び" items={lessons.map((l) => ({ id: l.id, title: l.text }))} />
      </Part>
      <Stack direction="row" gap={2}>
        <StopButton scope="office" target="office" label="すべての社員を止める" />
      </Stack>
    </Section>
  );
}

function Records() {
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
            <Stat key={st} label={st} value={tasks.filter((t) => t.state === st).length} unit="件" />
          ))}
        </Grid>
      </Part>
      <Part title="費用とトークン">
        <Table
          label="今月の費用とトークン"
          rowKey={(r) => r.id}
          rows={usage.map((u) => ({ ...u }))}
          columns={[
            { key: "who", header: "社員" },
            { key: "tokens", header: "トークン", numeric: true, render: (r) => r.tokens.toLocaleString("ja-JP") },
            { key: "cost", header: "費用", numeric: true, render: (r) => `${r.cost.toFixed(2)} ドル` },
          ]}
        />
      </Part>
    </Section>
  );
}

function Settings() {
  const [ext, setExt] = useState(() => new Set(extensions.filter((e) => e.installed).map((e) => e.id)));
  const [ended, setEnded] = useState<string[]>([]);
  return (
    <Section>
      <Card
        title="全体のルール"
        headingLevel={2}
        meta={[
          { label: "勤務の始め", value: "9:00" },
          { label: "勤務の長さ", value: "8 時間" },
          { label: "延長の上限", value: "30 分" },
        ]}
      />
      <Card title="サービスの初期値" headingLevel={2} meta={[{ label: "見る役", value: "作る役と別のモデル" }]} />
      <Card title="GitHub" headingLevel={2} actions={<Button disabled>連携する</Button>}>
        アプリの中のボタン 1 つで繋ぐ。まだ動かない
      </Card>
      <Part title="セッションと鍵">
        <List
          label="セッション"
          items={sessions
            .filter((s) => !ended.includes(s.id))
            .map((s) => ({
              id: s.id,
              title: s.device,
              meta: s.current ? "この端末" : `最後 ${s.last}`,
              side: s.current ? undefined : (
                <Button variant="quiet" aria-label={`${s.device}のセッションを切る`} onClick={() => setEnded((e) => [...e, s.id])}>
                  切る
                </Button>
              ),
            }))}
        />
        <p>鍵は入口だけが持ち、画面には出しません</p>
      </Part>
      <Part title="拡張">
        <List
          label="拡張"
          items={extensions.map((e) => ({
            id: e.id,
            title: e.title,
            meta: ext.has(e.id) ? "入れている" : "入れていない",
            side: (
              <Button
                variant="secondary"
                aria-label={`${e.title}を${ext.has(e.id) ? "外す" : "入れる"}`}
                onClick={() =>
                  setExt((cur) => {
                    const next = new Set(cur);
                    if (!next.delete(e.id)) next.add(e.id);
                    return next;
                  })
                }
              >
                {ext.has(e.id) ? "外す" : "入れる"}
              </Button>
            ),
          }))}
        />
      </Part>
    </Section>
  );
}

function More() {
  return (
    <Section>
      <List label="その他の画面" items={moreScreens.map((s) => ({ id: s.id, title: s.label, href: s.path }))} />
    </Section>
  );
}

export interface PageProps {
  screen: ScreenId | "more";
  pathname: string;
  query: URLSearchParams;
  health?: Health;
  navigate: Navigate;
}

export function Page({ screen, pathname, query, health, navigate }: PageProps) {
  switch (screen) {
    case "dashboard":
      return <Dashboard health={health} />;
    case "staff":
      return <StaffAndTasks pathname={pathname} query={query} navigate={navigate} />;
    case "goals":
      return <Goals />;
    case "office":
      return <Office />;
    case "services":
      return <Services pathname={pathname} navigate={navigate} />;
    case "guard":
      return <Guard />;
    case "records":
      return <Records />;
    case "settings":
      return <Settings />;
    case "more":
      return <More />;
    default:
      return screen satisfies never;
  }
}
