// 入口にあるレビュー。レビュー担当の要点とチェックの結果を変更の前に出し、変えたファイルを木に並べ、承認か差し戻し、指摘、その場の直しを入口に送る。読むだけの間はワークスペースを起こさない (タスクとレビューの 3.2)
import type { ReviewHead } from "@know-office/core";
import { Alert, Button, Link, List, SegmentedControl, Select, Stack, Status, TextField } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { ApiContext } from "../../api.ts";
import { Part } from "../../parts/section.tsx";
import { type Failed, failureOf, NETWORK, useReviewHead } from "./review-load.ts";
import { ReviewEditor } from "./ReviewEditor.tsx";
import { FailureAlert, ReviewFiles } from "./ReviewFiles.tsx";

export interface ReviewPageProps {
  /** 作った社員のタスク ID */
  nodeId: string;
  /** 作った社員 ID。タスクの一覧に戻る道に使う */
  staffId: string;
}

/**
 * 開いた時の先を読んだ事にする。次に開いた時は、ここからの差だけを出せる
 * @param nodeId 作った社員のタスク ID
 * @param head 開いた時の概要。読めていなければ何もしない
 */
function useMarkSeen(nodeId: string, head: ReviewHead | null): void {
  const api = useContext(ApiContext);
  // 作業中の変更は読んだ印を置く先が無い
  const sha = head?.working === false ? head.headSha : null;
  const seen = head?.lastSeenSha ?? null;
  useEffect(() => {
    // 間に push が届いていれば入口が 409 で断り、印は前のまま残るので、返事を待たない
    if (api && sha !== null && sha !== seen) void api.api.v1.reviews[":nodeId"].seen.$put({ param: { nodeId }, json: { sha } }).catch(() => null);
  }, [api, nodeId, sha, seen]);
}

interface WorkingProps {
  /** 作業中の変更の概要 */
  head: ReviewHead;
}

/** プルリクエストを出す前の作業中の変更。読むだけで、承認と差し戻し、行の指摘、その場の直しは出さない */
function Working({ head }: WorkingProps) {
  return (
    <>
      <p>作業中の変更 (プルリクエストの前)</p>
      <p>
        {head.repo} の {head.branch}
      </p>
      <Part title="変更">
        {head.baseSha === null || head.headSha === null ? (
          <p>まだ push がありません</p>
        ) : (
          <ReviewFiles key={head.headSha} nodeId={head.nodeId} files={head.files} since={null} head={head.headSha} range={{ baseSha: head.baseSha, headSha: head.headSha }} onNote={() => undefined} />
        )}
      </Part>
    </>
  );
}

interface VerdictProps {
  head: ReviewHead;
  onDone: (text: string) => void;
}

/** 承認か差し戻しを出す。読んだ先を添え、間に変更が足されていれば入口が 409 で断る */
function Verdict({ head, onDone }: VerdictProps) {
  const api = useContext(ApiContext);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"approve" | "request_changes" | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const send = async (verdict: "approve" | "request_changes") => {
    if (!api || head.headSha === null) return setFailed(NETWORK);
    setBusy(verdict);
    const res = await api.api.v1.reviews[":nodeId"].verdict.$post({ param: { nodeId: head.nodeId }, json: { verdict, body, baseSha: head.headSha } }).catch(() => null);
    setBusy(null);
    if (res?.ok) return onDone(verdict === "approve" ? "承認を出し、GitHub にも写しました" : "差し戻し、作る役に戻しました");
    setFailed(res ? await failureOf(res) : NETWORK);
  };
  return (
    <Stack gap={3}>
      <TextField label="判断の一言" value={body} onChange={(e) => setBody(e.target.value)} multiline />
      <Stack direction="row" gap={2} wrap>
        <Button loading={busy === "approve"} disabled={busy !== null} onClick={() => void send("approve")}>
          承認する
        </Button>
        <Button variant="secondary" loading={busy === "request_changes"} disabled={busy !== null} onClick={() => void send("request_changes")}>
          差し戻す
        </Button>
      </Stack>
      {failed?.code === "conflict" ? <Alert tone="warn">読んだ後に変更が足されました。読み直してから判断してください</Alert> : null}
      {failed && failed.code !== "conflict" ? <FailureAlert title="判断を送れませんでした" failed={failed} /> : null}
    </Stack>
  );
}

/** レビューの画面 */
export function ReviewPage({ nodeId, staffId }: ReviewPageProps) {
  const [version, setVersion] = useState(0);
  const loaded = useReviewHead(nodeId, version);
  const head = loaded.state === "ok" ? loaded.data : null;
  // 開いた時の印を持ち、読んだ事にした後も、この画面の間は前に見た所からの差を出せるようにする
  const [opened, setOpened] = useState<{ head: string; since: string | null } | null>(null);
  if (head?.headSha && opened?.head !== head.headSha) setOpened({ head: head.headSha, since: head.lastSeenSha });
  useMarkSeen(nodeId, head);
  const [view, setView] = useState("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [done, setDone] = useState<string>();
  const back = (
    <Link href={`/staff/${staffId}?tab=tasks`} standalone>
      タスクの一覧に戻る
    </Link>
  );
  if (loaded.state === "loading") return <Stack gap={4}>{back}<p role="status">レビューを読んでいます</p></Stack>;
  if (loaded.state === "failed") return <Stack gap={4}>{back}<FailureAlert title="レビューを読めませんでした" failed={loaded} /></Stack>;
  const data = loaded.data;
  // 画面は自分から読み直さず、開いた時と押した時だけ読む
  if (data.working) {
    return (
      <Stack gap={4}>
        {back}
        <h2>変更のレビュー</h2>
        <Working head={data} />
      </Stack>
    );
  }
  const headSha = data.headSha ?? "";
  const since = opened?.since ?? null;
  const fixed = since !== null && since !== headSha;
  const onlyNew = fixed && view === "since";
  const reload = (text: string) => {
    setDone(text);
    setEditing(null);
    setVersion((v) => v + 1);
  };
  return (
    <Stack gap={4}>
      {back}
      <h2>変更のレビュー</h2>
      <p>
        {data.repo} {data.prNumber === null ? "" : `の #${String(data.prNumber)} `}({data.branch})
      </p>
      <Part title="要点">
        <p>{data.reviewerSummary === "" ? "レビュー担当の要点はまだありません" : data.reviewerSummary}</p>
        {data.reviewerVerdict ? <Status kind={data.reviewerVerdict === "approve" ? "success" : "warn"} label={data.reviewerVerdict === "approve" ? "レビュー担当は承認" : "レビュー担当は差し戻し"} /> : null}
      </Part>
      <Part title="チェック">
        <List
          label="チェックの結果"
          items={data.checks.map((ch) => ({ id: ch.name, title: ch.name, side: <Status kind={ch.ok ? "success" : "error"} label={ch.ok ? "通った" : "落ちた"} /> }))}
          emptyText="チェックの結果はまだありません"
        />
      </Part>
      <Part title="変更">
        {fixed ? (
          <SegmentedControl
            label="見せる変更"
            value={view}
            onValueChange={setView}
            options={[
              { value: "all", label: "全部" },
              { value: "since", label: "前に見た所からの差" },
            ]}
          />
        ) : null}
        <ReviewFiles key={`${view}/${headSha}`} nodeId={nodeId} files={onlyNew ? data.files.filter((f) => !f.seen) : data.files} since={onlyNew ? since : null} head={headSha} onNote={setDone} />
      </Part>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      <Part title="判断">
        <Verdict head={data} onDone={reload} />
      </Part>
      <Part title="直す">
        <Select aria-label="直すファイル" placeholder="直すファイルを選ぶ" value={editing} onValueChange={setEditing} options={data.files.filter((f) => f.status !== "removed").map((f) => ({ value: f.path, label: f.path }))} />
        {editing ? <ReviewEditor key={`${editing}/${headSha}`} nodeId={nodeId} path={editing} head={headSha} onCommitted={reload} /> : null}
      </Part>
    </Stack>
  );
}
