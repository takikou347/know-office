// 設定の 1 項目のカード。見出し、1 行の説明、今の値と右下の編集のボタンを出し、編集を押すとその場で入力と理由の欄、保存と取り消しに替わる
import { Alert, Button, Card, Stack, TextField } from "knowidea-ui";
import { type ReactNode, useState } from "react";
import { type Failed, FailedAlert } from "./load.tsx";

/** 保存した結果。変えた知らせの文か、断られた理由 */
export type SaveResult = { ok: true; done: string } | { ok: false; failure: Failed };

export interface SettingCardProps {
  /** 見出し。項目の名前 */
  title: string;
  /** 見出しの下の 1 行の説明 */
  description: ReactNode;
  /** 今の値を言葉にした物 */
  current: string;
  /** 編集の間に出す入力 */
  editor: ReactNode;
  /** 入力の形が合わない時の文。合えば undefined */
  invalid?: string | undefined;
  /** 今の値と違い、形も合う値ができているか */
  ready: boolean;
  /** 理由を受けて保存する */
  save: (reason: string) => Promise<SaveResult>;
  /** 断られた知らせの題を作る */
  refusedTitle: (failure: Failed) => string;
  /** 取り消した時に呼ぶ。入力を今の値に戻す */
  onCancel: () => void;
  /** 作り直す前のカードで断られた理由 */
  refusal?: Failed | undefined;
  /** 編集できない時に、編集のボタンの代わりに今の値の下に出す物 */
  locked?: ReactNode;
  /** 見出しの h の段。既定 3 */
  headingLevel?: 2 | 3;
  /** 見出しの隣の印。無ければ出さない */
  badge?: ReactNode;
}

/** 設定の 1 項目。今の値を見せ、編集を押すとその場で変えて理由を添えて保存する */
export function SettingCard({ title, description, current, editor, invalid, ready, save, refusedTitle, onCancel, refusal, locked, badge, headingLevel = 3 }: SettingCardProps) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed | undefined>(refusal);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setDone(undefined);
    setFailure(undefined);
    const result = await save(reason.trim());
    setBusy(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setReason("");
    setEditing(false);
    setDone(result.done);
  };

  const cancel = () => {
    setReason("");
    setEditing(false);
    onCancel();
  };

  let actions: ReactNode;
  if (locked === undefined) {
    actions = editing ? (
      <>
        <Button variant="secondary" aria-label={`${title}の編集を取り消す`} disabled={busy} onClick={cancel}>
          取り消す
        </Button>
        <Button aria-label={`${title}を保存`} loading={busy} disabled={!ready || reason.trim() === ""} onClick={() => void submit()}>
          保存
        </Button>
      </>
    ) : (
      <Button
        variant="secondary"
        aria-label={`${title}を編集`}
        onClick={() => {
          // 断られた知らせは、保存し直すまで残す
          setDone(undefined);
          setEditing(true);
        }}
      >
        編集
      </Button>
    );
  }

  return (
    <Card title={title} titleSize="lg" actionsAlign="end" headingLevel={headingLevel} badge={badge} actions={actions}>
      <p>{description}</p>
      {editing ? (
        <Stack gap={3}>
          {editor}
          {invalid === undefined ? null : <p role="alert">{invalid}</p>}
          <TextField label={`${title}を変える理由`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        </Stack>
      ) : (
        <p>
          <strong>{current}</strong>
        </p>
      )}
      {locked}
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title={refusedTitle(failure)} failure={failure} /> : null}
    </Card>
  );
}
