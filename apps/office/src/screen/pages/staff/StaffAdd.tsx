// 社員の一覧の上の「社員を追加」。職種、名前、モデル、上司を選んで足す (タスクとレビューの 3.4、API の staff)
import { JOB_MODEL, StaffOverview, type StaffId } from "@know-office/core";
import { JOBS } from "@know-office/core/master/jobs";
import { labelOf, optionsOf } from "@know-office/core/master/master";
import { MODELS } from "@know-office/core/master/models";
import { Button, Dialog, DialogClose, Field, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";

/** 足せる職種。社長は 1 人だけなので出さない */
const ADDABLE = JOBS.filter((j) => j.value !== "president");
type AddableJob = "builder" | "reviewer";

/** 社員の名前の長さの上限 */
const MAX_NAME = 40;

export interface StaffAddProps {
  /** 上司に選べる在籍の社員 */
  people: StaffOverview[];
  /** 足した後に呼ぶ。足した社員を開く */
  onAdded: (id: StaffId) => void;
}

/**
 * 社員を足すボタンとダイアログ。名前の初期値は職種の名前、モデルの初期値は職種のモデル、上司の初期値は社長
 * @param props 在籍の社員、足した後に呼ぶ
 * @returns ボタンとダイアログ
 */
export function StaffAdd({ people, onAdded }: StaffAddProps) {
  const api = useContext(ApiContext);
  const president = people.find((p) => p.job === "president")?.id ?? "president";
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<AddableJob>("builder");
  const [name, setName] = useState("");
  const [model, setModel] = useState<string>(JOB_MODEL.builder);
  const [boss, setBoss] = useState<string>(president);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const role = name.trim() === "" ? labelOf(JOBS, job) : name.trim();

  const reset = () => {
    setJob("builder");
    setName("");
    setModel(JOB_MODEL.builder);
    setBoss(president);
    setFailure(undefined);
  };

  const submit = async () => {
    if (!api || busy) return;
    const parsedModel = MODELS.find((m) => m.value === model)?.value;
    const bossId = people.find((p) => p.id === boss)?.id;
    if (parsedModel === undefined || bossId === undefined) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.staff.$post({ json: { job, role, bossId, model: parsedModel } }), { required: true });
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    const body: unknown = await sent.res.json();
    const made = z.object({ data: StaffOverview }).safeParse(body);
    setOpen(false);
    reset();
    if (made.success) onAdded(made.data.data.id);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) reset();
      }}
      trigger={<Button>社員を追加</Button>}
      title="社員を追加"
      description="社員を 1 人足すと、Claude の費用とワークスペースの稼働が増えます。足す時はパスキーで確かめます。"
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} onClick={() => void submit()}>
            追加する
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <Field label="職種" required>
          <Select
            aria-label="職種"
            options={optionsOf(ADDABLE)}
            value={job}
            onValueChange={(v) => {
              const next = ADDABLE.find((j) => j.value === v)?.value;
              if (next === undefined || next === "president") return;
              setJob(next);
              setModel(JOB_MODEL[next]);
            }}
          />
        </Field>
        <TextField label="名前" hint={`空のままなら「${labelOf(JOBS, job)}」`} maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="モデル" required hint={MODELS.find((m) => m.value === model)?.note}>
          <Select aria-label="モデル" options={optionsOf(MODELS)} value={model} onValueChange={(v) => setModel(v ?? model)} />
        </Field>
        <Field label="上司" required>
          <Select aria-label="上司" options={people.map((p) => ({ value: p.id, label: p.role }))} value={boss} onValueChange={(v) => setBoss(v ?? boss)} />
        </Field>
        {failure ? <FailedAlert title="社員を追加できませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}
