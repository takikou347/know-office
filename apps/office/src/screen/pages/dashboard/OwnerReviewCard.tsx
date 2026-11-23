// ホームの、オーナーの判断を待つレビュー 1 件。差分を開く道と、その場で承認か差し戻しを出すボタン (タスクとレビューの 3.4)
import { APPROVAL_KIND_LABEL, type OwnerReview } from "@know-office/core";
import { Button, Card, Dialog, DialogClose, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";
import { taskHref } from "../../parts/tasks.ts";
import { requesterName } from "../approvals/kinds.ts";

/** 承認か差し戻し */
type Verdict = "approve" | "request_changes";

const VERDICT_LABEL: Record<Verdict, string> = { approve: "承認する", request_changes: "差し戻す" };
const DONE_LABEL: Record<Verdict, string> = { approve: "承認しました", request_changes: "差し戻しました" };

export interface OwnerReviewCardProps {
  /** オーナーの判断を待つレビュー */
  review: OwnerReview;
  /** 出した後に呼ぶ。知らせる文を受ける */
  onDecided: (text: string) => void;
}

/** オーナーの判断を待つレビュー 1 件 */
export function OwnerReviewCard({ review, onDecided }: OwnerReviewCardProps) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const title = `${APPROVAL_KIND_LABEL.merge}: ${review.title}`;
  const who = review.assignee === null ? "" : `${requesterName(review.assignee)}が `;
  return (
    <Card
      title={title}
      headingLevel={3}
      subtitle={`${who}${jstDateTime(review.requestedAt)} に頼んだ`}
      actions={
        <>
          <Button variant="secondary" onClick={() => setVerdict("request_changes")}>
            差し戻す
          </Button>
          <Button onClick={() => setVerdict("approve")}>承認する</Button>
        </>
      }
    >
      <Stack gap={2}>
        <p>
          {review.repo} の PR #{review.prNumber}。レビュー担当は承認しています。
        </p>
        {review.assignee === null ? null : <a href={taskHref(review.assignee, review.nodeId)}>差分を見る</a>}
      </Stack>
      {verdict ? (
        <VerdictDialog
          review={review}
          title={title}
          verdict={verdict}
          onClose={() => setVerdict(null)}
          onDecided={(text) => {
            setVerdict(null);
            onDecided(text);
          }}
        />
      ) : null}
    </Card>
  );
}

interface VerdictDialogProps {
  /** レビュー */
  review: OwnerReview;
  /** 見出し */
  title: string;
  /** 承認か差し戻し */
  verdict: Verdict;
  /** 閉じた時に呼ぶ */
  onClose: () => void;
  /** 出した後に呼ぶ */
  onDecided: (text: string) => void;
}

/** 理由を入れて承認か差し戻しを出すダイアログ。差し戻しは理由が要る。出せなければ開いたまま理由を出す */
function VerdictDialog({ review, title, verdict, onClose, onDecided }: VerdictDialogProps) {
  const api = useContext(ApiContext);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const label = VERDICT_LABEL[verdict];
  const ready = verdict === "approve" || body.trim() !== "";

  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.reviews[":nodeId"].verdict.$post({ param: { nodeId: review.nodeId }, json: { verdict, body: body.trim(), baseSha: review.headSha } }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    onDecided(`「${title}」を${DONE_LABEL[verdict]}`);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={verdict === "approve" ? "承認しますか" : "差し戻しますか"}
      description={title}
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} disabled={busy || !ready} onClick={() => void submit()}>
            {label}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <TextField label={verdict === "approve" ? "ひとこと (任意)" : "理由"} required={verdict === "request_changes"} value={body} maxLength={20_000} onChange={(e) => setBody(e.target.value)} />
        {failure ? <FailedAlert title={`${label}事ができませんでした`} failure={failure} /> : null}
        {failure?.code === "conflict" ? <p>確かめた後に変更が足されました。差分を見直してください。</p> : null}
      </Stack>
    </Dialog>
  );
}
