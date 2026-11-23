// 社員の設定のタブ。名前、上司、モデル、勤務の時刻をその場で直し、社員を削除する (タスクとレビューの 3.4、API の staff)
import { type StaffOverview, WorkSchedule } from "@know-office/core";
import { JOBS } from "@know-office/core/master/jobs";
import { labelOf, optionsOf } from "@know-office/core/master/master";
import { MODELS } from "@know-office/core/master/models";
import { Button, Checkbox, ConfirmDialog, Field, Select, Stack, Table, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";
import { Part } from "../../parts/section.tsx";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 勤務の時刻の選ぶ欄の値。全体の勤務の時刻のままか、この社員だけの時刻か */
const OWN = "own";
const OFFICE = "office";

/** 直している中身 */
type Draft = { role: string; bossId: string | null; model: string; schedule: WorkSchedule | null };

/**
 * 勤務の時刻を 1 行の文にする
 * @param schedule 勤務の時刻。null は全体の勤務の時刻
 * @returns 文
 */
function scheduleText(schedule: WorkSchedule | null): string {
  if (schedule === null) return "全体の勤務の時刻のまま";
  return `${schedule.start} から ${schedule.end}、${schedule.days.map((d) => WEEKDAYS[d] ?? "").join("・")}`;
}

export interface StaffSettingsProps {
  /** 直す社員 */
  s: StaffOverview;
  /** 上司に選べる在籍の社員 */
  people: StaffOverview[];
  /** 直した後と削除した後に呼ぶ。一覧を読み直す */
  onChanged: (deleted: boolean) => void;
}

/**
 * 社員の設定。読む時は表で出し、「編集」でその場の入力にして、右下の「保存」か「やめる」で終える。社長には削除を出さない
 * @param props 社員、在籍の社員、直した後に呼ぶ
 * @returns 設定のタブ
 */
export function StaffSettings({ s, people, onChanged }: StaffSettingsProps) {
  const api = useContext(ApiContext);
  const initial: Draft = { role: s.role, bossId: s.bossId, model: s.model, schedule: WorkSchedule.nullable().catch(null).parse(s.schedule) };
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const bossOptions = people.filter((p) => p.id !== s.id).map((p) => ({ value: p.id, label: p.role }));
  const roleOf = (id: string | null) => (id === null ? "無し" : (people.find((p) => p.id === id)?.role ?? id));
  const scheduleValid = draft === null || draft.schedule === null || (draft.schedule.start !== draft.schedule.end && draft.schedule.days.length > 0);

  const save = async () => {
    if (!api || !draft || busy || draft.role.trim() === "" || !scheduleValid) return;
    const model = MODELS.find((m) => m.value === draft.model)?.value;
    const bossId = people.find((p) => p.id === draft.bossId)?.id;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () =>
      api.api.v1.staff[":staffId"].$patch({
        param: { staffId: s.id },
        json: {
          version: s.version,
          ...(draft.role.trim() === s.role ? {} : { role: draft.role.trim() }),
          ...(bossId === undefined || bossId === s.bossId ? {} : { bossId }),
          ...(model === undefined || model === s.model ? {} : { model }),
          ...(JSON.stringify(draft.schedule) === JSON.stringify(initial.schedule) ? {} : { schedule: draft.schedule }),
        },
      }),
    );
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setDraft(null);
    onChanged(false);
  };

  const remove = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.staff[":staffId"].$delete({ param: { staffId: s.id } }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    onChanged(true);
  };

  if (draft === null) {
    return (
      <Stack gap={3}>
        <Table
          label={`${s.role}の設定`}
          rowKey={(r) => r.id}
          columns={[
            { key: "item", header: "項目" },
            { key: "value", header: "今の値" },
          ]}
          rows={[
            { id: "role", item: "名前", value: s.role },
            { id: "job", item: "職種", value: labelOf(JOBS, s.job) },
            { id: "boss", item: "上司", value: roleOf(s.bossId) },
            { id: "model", item: "モデル", value: labelOf(MODELS, s.model) },
            { id: "schedule", item: "勤務の時刻", value: scheduleText(initial.schedule) },
          ]}
        />
        {failure ? <FailedAlert title="社員を削除できませんでした" failure={failure} /> : null}
        <Stack direction="row" gap={2} justify="end">
          {s.job === "president" ? null : (
            <ConfirmDialog
              trigger={
                <Button variant="danger" loading={busy}>
                  社員を削除
                </Button>
              }
              title={`${s.role}を削除しますか`}
              description="終わっていないタスクは同じ職種の手の空いた社員に移ります。勤怠と会話と使用量の記録は残ります。作業中の社員は区切りの後に削除できます。"
              confirmLabel="削除する"
              tone="danger"
              onConfirm={() => void remove()}
            />
          )}
          <Button variant="secondary" onClick={() => setDraft(initial)}>
            編集
          </Button>
        </Stack>
      </Stack>
    );
  }

  const schedule = draft.schedule;
  return (
    <Part title="設定を直す">
      <Stack gap={3}>
        <TextField label="名前" required maxLength={40} value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
        {s.job === "president" ? null : (
          <Field label="上司" required>
            <Select aria-label="上司" options={bossOptions} value={draft.bossId} onValueChange={(v) => setDraft({ ...draft, bossId: v ?? draft.bossId })} />
          </Field>
        )}
        <Field label="モデル" required hint={`${MODELS.find((m) => m.value === draft.model)?.note ?? ""}。次のタスクから効きます。高いモデルに替える時はパスキーで確かめます`}>
          <Select aria-label="モデル" options={optionsOf(MODELS)} value={draft.model} onValueChange={(v) => setDraft({ ...draft, model: v ?? draft.model })} />
        </Field>
        <Field label="勤務の時刻" hint="勤務を長くする時はパスキーで確かめます">
          <Select
            aria-label="勤務の時刻"
            options={[
              { value: OFFICE, label: "全体の勤務の時刻のまま" },
              { value: OWN, label: "この社員だけの時刻" },
            ]}
            value={schedule === null ? OFFICE : OWN}
            onValueChange={(v) => setDraft({ ...draft, schedule: v === OWN ? (schedule ?? { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }) : null })}
          />
        </Field>
        {schedule === null ? null : (
          <>
            <Stack direction="row" gap={3} wrap>
              <TextField label="始まり (日本時間)" type="time" value={schedule.start} onChange={(e) => setDraft({ ...draft, schedule: { ...schedule, start: e.target.value } })} />
              <TextField label="終わり (日本時間)" type="time" value={schedule.end} onChange={(e) => setDraft({ ...draft, schedule: { ...schedule, end: e.target.value } })} />
            </Stack>
            <fieldset>
              <legend>勤務の曜日</legend>
              <Stack direction="row" gap={3} wrap>
                {WEEKDAYS.map((name, day) => (
                  <Checkbox
                    key={name}
                    label={name}
                    checked={schedule.days.includes(day)}
                    onCheckedChange={(on) => setDraft({ ...draft, schedule: { ...schedule, days: WEEKDAYS.flatMap((_, d) => ((d === day ? on : schedule.days.includes(d)) ? [d] : [])) } })}
                  />
                ))}
              </Stack>
            </fieldset>
          </>
        )}
        {scheduleValid ? null : <p role="alert">始まりと終わりを違う時刻にし、曜日を 1 つ以上選んでください</p>}
        {failure ? <FailedAlert title="設定を保存できませんでした" failure={failure} /> : null}
        <Stack direction="row" gap={2} justify="end">
          <Button variant="secondary" disabled={busy} onClick={() => setDraft(null)}>
            やめる
          </Button>
          <Button loading={busy} disabled={draft.role.trim() === "" || !scheduleValid} onClick={() => void save()}>
            保存
          </Button>
        </Stack>
      </Stack>
    </Part>
  );
}
