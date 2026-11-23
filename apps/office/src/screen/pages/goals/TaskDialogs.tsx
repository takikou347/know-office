// 目標の画面で、目標の下にタスクを足して社員に頼み、頼む先と期限を変え、取り消す。入力は選ぶ欄と日付のピッカーを基本にする (タスクとレビューの 3.1、API の nodes)
import type { NodeTree, OrgStaff } from "@know-office/core";
import { Repo, StaffId } from "@know-office/core";
import { optionsOf } from "@know-office/core/master/master";
import { TASK_KINDS } from "@know-office/core/master/task-kinds";
import { Button, DatePicker, Dialog, DialogClose, Field, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { dateOf, dayOf } from "./model.ts";

/** 頼む先を決めない時の選ぶ欄の値 */
const NOBODY = "nobody";

/** 新しいプロジェクトを作る時の選ぶ欄の値 */
const NEW_PROJECT = "new";

/** リポジトリを付けない時の選ぶ欄の値 */
const NO_REPO = "none";

type OwnerTaskKind = (typeof TASK_KINDS)[number]["value"];

/** 頼み直し、取り消せるタスクの状態。作業中、レビュー中、完了、取り消したタスクは頼む先を変えない */
const CHANGEABLE: readonly string[] = ["todo", "stopped", "waiting_owner"];

/**
 * 頼む先の選ぶ欄の並び。社員は組織図の役職で出す
 * @param staff 組織図の社員
 * @returns 選ぶ欄の並び
 */
function assigneeOptions(staff: OrgStaff[]): { value: string; label: string }[] {
  return [{ value: NOBODY, label: "まだ頼まない" }, ...staff.map((p) => ({ value: p.id, label: p.role }))];
}

/**
 * 社員 ID を役職にする。組織図に無ければ ID のまま出す
 * @param staff 組織図の社員
 * @param id 社員 ID
 * @returns 役職
 */
export function roleOf(staff: OrgStaff[], id: string | null): string {
  if (id === null) return "まだ頼まない";
  return staff.find((p) => p.id === id)?.role ?? id;
}

/**
 * 選ぶ欄の値を社員 ID にする。頼まない時と知らない値は無し
 * @param value 選ぶ欄の値
 * @returns 社員 ID か無し
 */
function staffOf(value: string): StaffId | undefined {
  const id = StaffId.safeParse(value);
  return id.success ? id.data : undefined;
}

/**
 * 目標の下のプロジェクトを集める。受け付けのプロジェクトはそれ自身
 * @param goal 目標か受け付けのプロジェクト
 * @returns プロジェクトの並び
 */
export function projectsOf(goal: NodeTree): NodeTree[] {
  return goal.kind === "project" ? [goal] : goal.children.filter((c) => c.kind === "project");
}

interface RepoSelectProps {
  /** 選んでいる値。付けない時は NO_REPO */
  value: string;
  /** 選び直した時に呼ぶ */
  onChange: (value: string) => void;
}

/** GitHub の触れるリポジトリから選ぶ欄。つないでいなければ「リポジトリ無し」だけを出す */
function RepoSelect({ value, onChange }: RepoSelectProps) {
  const repos = useLoad(z.array(Repo), (a) => a.api.v1.github.repos.$get({ query: { limit: "100" } }));
  const options = [{ value: NO_REPO, label: "リポジトリ無し" }, ...(repos.state === "ok" ? repos.data.map((r) => ({ value: r.fullName, label: r.fullName })) : [])];
  return (
    <Field label="リポジトリ" hint={repos.state === "failed" ? "設定の画面で GitHub とつなぐと選べます" : "社員が直すリポジトリ"}>
      <Select aria-label="リポジトリ" loading={repos.state === "loading"} value={value} options={options} onValueChange={(v) => onChange(v ?? NO_REPO)} />
    </Field>
  );
}

interface AddTaskProps {
  /** タスクを足す目標か、受け付けのプロジェクト */
  goal: NodeTree;
  /** 頼む先に選べる社員 */
  staff: OrgStaff[];
  /** 社員を読んでいる間は、頼む先を選ばせない */
  staffLoading: boolean;
  /** 足した後に呼ぶ。木を読み直すのに使う */
  onDone: () => void;
  /** プロジェクトだけを作れてタスクを足せないまま閉じた時に呼ぶ。木を読み直すのに使う */
  onCreated: () => void;
}

/** 目標の下にタスクを足すボタンとダイアログ。プロジェクト、種類、頼む先、リポジトリは選び、期限はピッカーで決める */
export function AddTask({ goal, staff, staffLoading, onDone, onCreated }: AddTaskProps) {
  const api = useContext(ApiContext);
  const projects = projectsOf(goal);
  const firstProject = projects[0]?.id ?? NEW_PROJECT;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [project, setProject] = useState(firstProject);
  const [projectName, setProjectName] = useState(projects.length === 0 ? goal.title : "");
  // プロジェクトを作れてタスクを足せなかった時に、作ったプロジェクトを選ぶ欄に残す
  const [made, setMade] = useState<{ value: string; label: string } | null>(null);
  const [kind, setKind] = useState<OwnerTaskKind>("build");
  const [assignee, setAssignee] = useState(NOBODY);
  const [repo, setRepo] = useState(NO_REPO);
  const [due, setDue] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const name = `「${goal.title}」にタスクを足す`;
  const needsName = project === NEW_PROJECT && projectName.trim() === "";
  const ready = title.trim() !== "" && !needsName;

  const reset = () => {
    setTitle("");
    setBody("");
    setProject(firstProject);
    setProjectName(projects.length === 0 ? goal.title : "");
    setKind("build");
    setAssignee(NOBODY);
    setRepo(NO_REPO);
    setDue(null);
    setFailure(undefined);
    setMade(null);
  };

  /**
   * 足す先のプロジェクトを決める。新しいプロジェクトなら先に作り、作れたら選び直して二重に作らない
   * @returns プロジェクトの ID。作れなければ null
   */
  const projectId = async (): Promise<string | null> => {
    if (project !== NEW_PROJECT) return project;
    if (!api) return null;
    const sent = await send(api, () => api.api.v1.nodes.$post({ json: { kind: "project", parentId: goal.id, scope: goal.scope, title: projectName.trim() } }));
    if (!sent.ok) {
      setFailure(sent.failure);
      return null;
    }
    const id = z.object({ data: z.object({ id: z.string() }).loose() }).loose().parse(await sent.res.json()).data.id;
    setMade({ value: id, label: projectName.trim() });
    setProject(id);
    return id;
  };

  const submit = async () => {
    if (!api || busy || !ready) return;
    setBusy(true);
    setFailure(undefined);
    const parentId = await projectId();
    if (parentId === null) {
      setBusy(false);
      return;
    }
    const who = staffOf(assignee);
    const sent = await send(api, () =>
      api.api.v1.nodes.$post({
        json: {
          kind: "task",
          parentId,
          scope: goal.scope,
          title: title.trim(),
          taskKind: kind,
          ...(body.trim() === "" ? {} : { body: body.trim() }),
          ...(who === undefined ? {} : { assignee: who }),
          ...(repo === NO_REPO ? {} : { repo }),
          ...(due === null ? {} : { dueDay: dayOf(due) }),
        },
      }),
    );
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setOpen(false);
    reset();
    onDone();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) return;
        if (made) onCreated();
        reset();
      }}
      trigger={<Button>タスクを足す</Button>}
      title={name}
      description="頼んだ社員は、手が空いていればすぐに取ります。勤務時間外なら呼び出して取ります。"
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} disabled={!ready} onClick={() => void submit()}>
            足す
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <TextField label="題" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        {goal.kind === "goal" ? (
          <Field label="プロジェクト">
            <Select
              aria-label="プロジェクト"
              value={project}
              options={[...projects.map((p) => ({ value: p.id, label: p.title })), ...(made ? [made] : []), { value: NEW_PROJECT, label: "新しいプロジェクト" }]}
              onValueChange={(v) => setProject(v ?? firstProject)}
            />
          </Field>
        ) : null}
        {project === NEW_PROJECT ? <TextField label="プロジェクトの名前" required maxLength={200} value={projectName} onChange={(e) => setProjectName(e.target.value)} /> : null}
        <Field label="種類">
          <Select
            aria-label="種類"
            value={kind}
            options={optionsOf(TASK_KINDS)}
            onValueChange={(v) => {
              const next = TASK_KINDS.find((k) => k.value === v);
              if (next) setKind(next.value);
            }}
          />
        </Field>
        <Field label="頼む先">
          <Select aria-label="頼む先" loading={staffLoading} value={assignee} options={assigneeOptions(staff)} onValueChange={(v) => setAssignee(v ?? NOBODY)} />
        </Field>
        <RepoSelect value={repo} onChange={setRepo} />
        <Field label="期限">
          <DatePicker aria-label="期限" value={due} onValueChange={setDue} clearable placeholder="期限を選ぶ" />
        </Field>
        <TextField label="本文" hint="無くても足せます" multiline rows={3} maxLength={20_000} value={body} onChange={(e) => setBody(e.target.value)} />
        {failure ? <FailedAlert title="タスクを足せませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}

interface ChangeTaskProps {
  /** 変えるタスク */
  task: NodeTree;
  /** 頼む先に選べる社員 */
  staff: OrgStaff[];
  /** 社員を読んでいる間は、頼む先を選ばせない */
  staffLoading: boolean;
  /** 変えた後に呼ぶ。木を読み直すのに使う */
  onDone: () => void;
  /** ほかで先に変わっていた (409) 時に呼ぶ。木を読み直すとこのダイアログは閉じるので、知らせは呼ぶ側が出す */
  onConflict: () => void;
}

/** タスクの頼む先と期限を変える、タスクを取り消すボタンとダイアログ。完了と取り消したタスクには出さず、作業中とレビュー中は期限だけを変える */
export function ChangeTask({ task, staff, staffLoading, onDone, onConflict }: ChangeTaskProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [assignee, setAssignee] = useState(task.assignee ?? NOBODY);
  const [due, setDue] = useState<Date | null>(dateOf(task.dueDay));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  if (task.status === "done" || task.status === "dropped") return null;
  const changeable = CHANGEABLE.includes(task.status);
  const name = `${task.title}を変える`;
  const who = staffOf(assignee);
  const dueDay = due === null ? null : dayOf(due);
  const change = {
    ...(changeable && who !== undefined && who !== task.assignee ? { assignee: who } : {}),
    ...(dueDay === task.dueDay ? {} : { dueDay }),
  };

  const patch = async (json: { assignee?: StaffId; dueDay?: string | null } | { status: "dropped" }) => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.nodes[":nodeId"].$patch({ param: { nodeId: task.id }, json: { version: task.version, ...json } }));
    setBusy(false);
    if (!sent.ok) {
      // ほかで先に変わっていたら、今の木を読み直して版を合わせる。読み直すとこのダイアログは作り直されるので、知らせは呼ぶ側が出す
      if (sent.failure.code === "conflict") {
        setOpen(false);
        onConflict();
        return;
      }
      setFailure(sent.failure);
      return;
    }
    setOpen(false);
    onDone();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) return;
        setAssignee(task.assignee ?? NOBODY);
        setDue(dateOf(task.dueDay));
        setFailure(undefined);
      }}
      trigger={
        <Button variant="quiet" aria-label={name}>
          変える
        </Button>
      }
      title={name}
      description={changeable ? "タスクを取り消すと戻せません。" : "作業中とレビュー中のタスクは、期限だけを変えられます。"}
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          {changeable ? (
            <Button variant="danger" loading={busy} onClick={() => void patch({ status: "dropped" })}>
              取り消す
            </Button>
          ) : null}
          <Button loading={busy} disabled={Object.keys(change).length === 0} onClick={() => void patch(change)}>
            保存する
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <Field label="頼む先">
          <Select
            aria-label="頼む先"
            disabled={!changeable}
            loading={staffLoading}
            value={assignee}
            options={assigneeOptions(staff).filter((o) => o.value !== NOBODY || task.assignee === null)}
            onValueChange={(v) => setAssignee(v ?? NOBODY)}
          />
        </Field>
        <Field label="期限">
          <DatePicker aria-label="期限" value={due} onValueChange={setDue} clearable placeholder="期限を選ぶ" />
        </Field>
        {failure ? <FailedAlert title="タスクを変えられませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}
