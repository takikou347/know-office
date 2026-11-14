// 手で止めるボタン。押すと止まる範囲とタスクの数を確認の画面に出し、確かめた後に止める (自動停止の 3.7)
import type { GuardScope, StaffId, StopPreview } from "@know-office/core";
import { Alert, Button, Dialog, DialogClose } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { createApi } from "../../api.ts";

const SCOPE_LABEL: Record<GuardScope, string> = { task: "タスク", staff: "社員", service: "サービス", office: "全体" };
const STAFF_LABEL: Record<StaffId, string> = { president: "社長", builder: "作る役", reviewer: "見る役" };
const REASON = "オーナーが画面のボタンで止めた";

/** 止められなかった時に出す物。不具合を伝えられるよう traceId を添える */
type Failure = { code: string; traceId: string };

const ProblemFields = z.object({ code: z.string(), traceId: z.string() }).loose();

/**
 * 失敗の返事から code と traceId を読む
 * @param res 返事
 * @returns code と traceId
 */
async function failureOf(res: Response): Promise<Failure> {
  const body: unknown = await res.json().catch(() => null);
  const parsed = ProblemFields.safeParse(body);
  return parsed.success ? { code: parsed.data.code, traceId: parsed.data.traceId } : { code: String(res.status), traceId: "" };
}

/**
 * 自動停止のルートを呼ぶ口を作る
 * @returns /api/v1/guard の口
 */
const guardApi = () => createApi(window.location.origin).api.v1.guard;

export interface StopButtonProps {
  /** 止める範囲 */
  scope: GuardScope;
  /** 止める相手。全体は office */
  target: string;
  /** ボタンの文 */
  label: string;
}

/** 止める前に確認の画面を出すボタン */
export function StopButton({ scope, target, label }: StopButtonProps) {
  const [preview, setPreview] = useState<StopPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failure>();

  const open = async () => {
    setFailure(undefined);
    setDone(undefined);
    const res = await guardApi()["stop-previews"].$post({ json: { scope, target } });
    if (!res.ok) {
      setFailure(await failureOf(res));
      return;
    }
    setPreview((await res.json()).data);
  };

  const stop = async () => {
    setBusy(true);
    const res = await guardApi().stops.$post({ json: { scope, target, reason: REASON } });
    setBusy(false);
    setPreview(null);
    if (!res.ok) {
      setFailure(await failureOf(res));
      return;
    }
    setDone(`${SCOPE_LABEL[scope]}を止めました`);
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
      {failure ? (
        <Alert tone="error" live>
          止められませんでした ({failure.code})。不具合を伝える時は {failure.traceId || "なし"} を添えてください
        </Alert>
      ) : null}
    </>
  );
}
