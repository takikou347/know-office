// 目的と組織図の画面で、プロジェクトの下にタスクを足して社員に頼み、頼む先を変え、取り消す (タスクとレビューの 3.1、API の nodes)
import type { NodeTree, OrgStaff } from "@know-office/core";
import { RepoName, StaffId } from "@know-office/core";
import { Button, Dialog, DialogClose, RadioGroup, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";

/** 頼む先を決めない時の選ぶ欄の値 */
const NOBODY = "nobody";

/** オーナーが選べるタスクの種類 */
const TASK_KINDS = [
  { value: "build", label: "作る" },
  { value: "content", label: "コンテンツ" },
  { value: "fix", label: "直す" },
] as const;

type OwnerTaskKind = (typeof TASK_KINDS)[number]["value"];

/** 頼み直せるタスクの状態。作業中、確かめ待ち、済み、見送りのタスクは変えない */
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

interface AddTaskProps {
  /** タスクを足すプロジェクト */
  project: NodeTree;
  /** プロジェクトの親の目標。受け付けのプロジェクトには無い。同じ名前のプロジェクトを見分けるのに使う */
  goal?: NodeTree | undefined;
  /** 頼む先に選べる社員 */
  staff: OrgStaff[];
  /** 足した後に呼ぶ。木を読み直すのに使う */
  onDone: () => void;
}

/** プロジェクトの下にタスクを足すボタンとダイアログ。題、本文、種類、頼む先、リポジトリを入れる */
export function AddTask({ project, goal, staff, onDone }: AddTaskProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<OwnerTaskKind>("build");
  const [assignee, setAssignee] = useState(NOBODY);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const name = goal === undefined ? `「${project.title}」にタスクを足す` : `「${goal.title}」の「${project.title}」にタスクを足す`;
  const repoBad = repo.trim() !== "" && !RepoName.safeParse(repo.trim()).success;

  const reset = () => {
    setTitle("");
    setBody("");
    setKind("build");
    setAssignee(NOBODY);
    setRepo("");
    setFailure(undefined);
  };

  const submit = async () => {
    if (!api || busy || title.trim() === "" || repoBad) return;
    setBusy(true);
    setFailure(undefined);
    const who = staffOf(assignee);
    const sent = await send(api, () =>
      api.api.v1.nodes.$post({
        json: {
          kind: "task",
          parentId: project.id,
          scope: project.scope,
          title: title.trim(),
          taskKind: kind,
          ...(body.trim() === "" ? {} : { body: body.trim() }),
          ...(who === undefined ? {} : { assignee: who }),
          ...(repo.trim() === "" ? {} : { repo: repo.trim() }),
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
        if (!next) reset();
      }}
      trigger={
        <Button variant="quiet">
          {name}
        </Button>
      }
      title={name}
      description="頼んだ社員は、手が空いていればすぐに取ります。勤務時間外なら呼び出して取ります。"
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} disabled={title.trim() === "" || repoBad} onClick={() => void submit()}>
            タスクを足す
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <TextField label="題" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextField label="本文" multiline rows={4} maxLength={20_000} value={body} onChange={(e) => setBody(e.target.value)} />
        <RadioGroup
          legend="種類"
          value={kind}
          options={TASK_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          onValueChange={(v) => {
            const next = TASK_KINDS.find((k) => k.value === v);
            if (next) setKind(next.value);
          }}
        />
        <RadioGroup legend="頼む先" value={assignee} options={assigneeOptions(staff)} onValueChange={(v) => setAssignee(v)} />
        <TextField
          label="リポジトリ"
          hint="直すリポジトリを owner/name の形で。無ければ空のまま"
          error={repoBad ? "owner/name の形で入れてください" : undefined}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
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
  /** 変えた後に呼ぶ。木を読み直すのに使う */
  onDone: () => void;
  /** ほかで先に変わっていた (409) 時に呼ぶ。木を読み直すとこのダイアログは閉じるので、知らせは呼ぶ側が出す */
  onConflict: () => void;
}

/** タスクの頼む先を変える、タスクを取り消すボタンとダイアログ。作業中のタスクには出さない */
export function ChangeTask({ task, staff, onDone, onConflict }: ChangeTaskProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [assignee, setAssignee] = useState(task.assignee ?? NOBODY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  if (!CHANGEABLE.includes(task.status)) return null;
  const name = `${task.title}を変える`;
  const who = staffOf(assignee);

  const patch = async (change: { assignee: StaffId } | { status: "dropped" }) => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.nodes[":nodeId"].$patch({ param: { nodeId: task.id }, json: { version: task.version, ...change } }));
    setBusy(false);
    if (!sent.ok) {
      // ほかで先に変わっていたら、今の木を読み直して版を合わせる。読み直すとこのダイアログは作り直されるので、知らせは木の上に出す
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
        if (!next) setFailure(undefined);
      }}
      trigger={
        <Button variant="quiet">
          {name}
        </Button>
      }
      title={name}
      description={`今の頼む先: ${roleOf(staff, task.assignee)}。タスクを取り消すと見送りになり、戻せません。`}
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button variant="danger" loading={busy} onClick={() => void patch({ status: "dropped" })}>
            タスクを取り消す
          </Button>
          <Button loading={busy} disabled={who === undefined || who === task.assignee} onClick={() => void (who === undefined ? undefined : patch({ assignee: who }))}>
            頼む先を変える
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <RadioGroup legend="頼む先" value={assignee} options={assigneeOptions(staff).filter((o) => o.value !== NOBODY)} onValueChange={(v) => setAssignee(v)} />
        {failure ? <FailedAlert title="タスクを変えられませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}
