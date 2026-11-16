// 手で止めるボタン。押すと止まる範囲とタスクの数を確認の画面に出し、確かめた後に止める (自動停止の 3.6)
import type { GuardScope, StopPreview } from "@know-office/core";
import { Alert, Button, Dialog, DialogClose } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, failureOf } from "../../parts/load.tsx";
import { SCOPE_LABEL, STAFF_LABEL } from "./labels.ts";

const REASON = "オーナーが画面のボタンで止めた";

export interface StopButtonProps {
  /** 止める範囲 */
  scope: GuardScope;
  /** 止める相手。全体は office */
  target: string;
  /** ボタンの文 */
  label: string;
  /** 止めた後に呼ぶ。止めている物と記録を読み直すのに使う */
  onStopped?: () => void;
}

/** 止める前に確認の画面を出すボタン */
export function StopButton({ scope, target, label, onStopped }: StopButtonProps) {
  const api = useContext(ApiContext);
  const [preview, setPreview] = useState<StopPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();

  const open = async () => {
    if (!api) return;
    setFailure(undefined);
    setDone(undefined);
    const res = await api.api.v1.guard["stop-previews"].$post({ json: { scope, target } });
    if (!res.ok) {
      setFailure(await failureOf(res));
      return;
    }
    setPreview((await res.json()).data);
  };

  const stop = async () => {
    if (!api) return;
    setBusy(true);
    const res = await api.api.v1.guard.stops.$post({ json: { scope, target, reason: REASON } });
    setBusy(false);
    setPreview(null);
    if (!res.ok) {
      setFailure(await failureOf(res));
      return;
    }
    setDone(`${SCOPE_LABEL[scope]}を止めました`);
    onStopped?.();
  };

  return (
    <>
      <Button variant="danger" onClick={() => void open()}>
        {label}
      </Button>
      <Dialog
        open={preview !== null}
        onOpenChange={(next) => {
          if (!next) setPreview(null);
        }}
        title={`${SCOPE_LABEL[scope]}を止めますか`}
        description="止めると、社員の今の動きを切り、作業トークンを使えなくします。"
        actions={
          <>
            <DialogClose variant="secondary">取り消す</DialogClose>
            <Button variant="danger" loading={busy} onClick={() => void stop()}>
              止める
            </Button>
          </>
        }
      >
        {preview ? (
          <ul>
            <li>止まる範囲: {SCOPE_LABEL[scope]}</li>
            <li>止まる社員: {preview.staff.length === 0 ? "無し" : preview.staff.map((id) => STAFF_LABEL[id]).join("、")}</li>
            <li>止まるタスク: {preview.nodes} 件</li>
          </ul>
        ) : null}
      </Dialog>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="止められませんでした" failure={failure} /> : null}
    </>
  );
}
