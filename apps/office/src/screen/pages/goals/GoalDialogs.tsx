// 目標の画面で、目的を選んで目標を期限付きで足し、目標の名前と期限を変える。目的は選ぶ欄から選び、無ければその場で作る (タスクとレビューの 3.1、API の nodes)
import type { NodeTree } from "@know-office/core";
import { Button, DatePicker, Dialog, DialogClose, Field, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";
import { dateOf, dayOf } from "./model.ts";

/** 新しい目的を作る時の選ぶ欄の値 */
const NEW_PURPOSE = "new";

const Created = z.object({ data: z.object({ id: z.string() }).loose() }).loose();

interface AddGoalProps {
  /** 選べる目的 */
  purposes: NodeTree[];
  /** 足した後に、足した目標の ID で呼ぶ */
  onDone: (goalId: string) => void;
  /** 目的だけを作れて目標を足せないまま閉じた時に呼ぶ。木を読み直すのに使う */
  onCreated: () => void;
}

/** 目標を足すボタンとダイアログ。名前を書き、目的を選び、期限をピッカーで決める */
export function AddGoal({ purposes, onDone, onCreated }: AddGoalProps) {
  const api = useContext(ApiContext);
  const firstPurpose = purposes[0]?.id ?? NEW_PURPOSE;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState(firstPurpose);
  const [purposeName, setPurposeName] = useState("");
  // 目的を作れて目標を足せなかった時に、作った目的を選ぶ欄に残す
  const [made, setMade] = useState<{ value: string; label: string } | null>(null);
  const [due, setDue] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const ready = title.trim() !== "" && (purpose !== NEW_PURPOSE || purposeName.trim() !== "");

  const reset = () => {
    setTitle("");
    setPurpose(firstPurpose);
    setPurposeName("");
    setDue(null);
    setFailure(undefined);
    setMade(null);
  };

  /**
   * 目標を置く目的を決める。新しい目的なら先に作り、作れたら選び直して二重に作らない
   * @returns 目的の ID。作れなければ null
   */
  const purposeId = async (): Promise<string | null> => {
    if (purpose !== NEW_PURPOSE) return purpose;
    if (!api) return null;
    const sent = await send(api, () => api.api.v1.nodes.$post({ json: { kind: "purpose", scope: "office", title: purposeName.trim() } }));
    if (!sent.ok) {
      setFailure(sent.failure);
      return null;
    }
    const id = Created.parse(await sent.res.json()).data.id;
    setMade({ value: id, label: purposeName.trim() });
    setPurpose(id);
    return id;
  };

  const submit = async () => {
    if (!api || busy || !ready) return;
    setBusy(true);
    setFailure(undefined);
    const parentId = await purposeId();
    if (parentId === null) {
      setBusy(false);
      return;
    }
    const sent = await send(api, () => api.api.v1.nodes.$post({ json: { kind: "goal", parentId, scope: "office", title: title.trim(), ...(due === null ? {} : { dueDay: dayOf(due) }) } }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setOpen(false);
    reset();
    onDone(Created.parse(await sent.res.json()).data.id);
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
      trigger={<Button>目標を足す</Button>}
      title="目標を足す"
      description="目標は目的の下に置き、タスクは目標を開いて足します。"
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
        <TextField label="目標" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <Field label="目的">
          <Select
            aria-label="目的"
            value={purpose}
            options={[...purposes.map((p) => ({ value: p.id, label: p.title })), ...(made ? [made] : []), { value: NEW_PURPOSE, label: "新しい目的" }]}
            onValueChange={(v) => setPurpose(v ?? firstPurpose)}
          />
        </Field>
        {purpose === NEW_PURPOSE ? <TextField label="目的の名前" required maxLength={200} value={purposeName} onChange={(e) => setPurposeName(e.target.value)} /> : null}
        <Field label="期限">
          <DatePicker aria-label="期限" value={due} onValueChange={setDue} clearable placeholder="期限を選ぶ" />
        </Field>
        {failure ? <FailedAlert title="目標を足せませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}

interface ChangeGoalProps {
  /** 変える目標 */
  goal: NodeTree;
  /** 変えた後に呼ぶ。木を読み直すのに使う */
  onDone: () => void;
  /** ほかで先に変わっていた (409) 時に呼ぶ */
  onConflict: () => void;
}

/** 目標の名前と期限を変えるボタンとダイアログ */
export function ChangeGoal({ goal, onDone, onConflict }: ChangeGoalProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [due, setDue] = useState<Date | null>(dateOf(goal.dueDay));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const dueDay = due === null ? null : dayOf(due);
  const change = {
    ...(title.trim() === "" || title.trim() === goal.title ? {} : { title: title.trim() }),
    ...(dueDay === goal.dueDay ? {} : { dueDay }),
  };

  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.nodes[":nodeId"].$patch({ param: { nodeId: goal.id }, json: { version: goal.version, ...change } }));
    setBusy(false);
    if (!sent.ok) {
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
        setTitle(goal.title);
        setDue(dateOf(goal.dueDay));
        setFailure(undefined);
      }}
      trigger={<Button variant="secondary">目標を変える</Button>}
      title="目標を変える"
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} disabled={Object.keys(change).length === 0} onClick={() => void submit()}>
            保存する
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <TextField label="目標" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <Field label="期限">
          <DatePicker aria-label="期限" value={due} onValueChange={setDue} clearable placeholder="期限を選ぶ" />
        </Field>
        {failure ? <FailedAlert title="目標を変えられませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}
