// レビューの変えたファイル。木に並べ、最初のファイルだけを先に読み、残りは開いた時に読む。行を選んで指摘を書ける (タスクとレビューの 3.2)
import type { ReviewHead } from "@know-office/core";
import { Accordion, Alert, Badge, Button, type DiffLine, DiffView, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, failureOf, NETWORK, toDiffFile, useFileDiff, type WorkingRange } from "./review-load.ts";

type ReviewFile = ReviewHead["files"][number];

const STATUS_LABEL: Record<ReviewFile["status"], string> = { added: "足した", modified: "変えた", removed: "消した", renamed: "名前を変えた" };

export interface FailureAlertProps {
  /** 何を読めなかったか */
  title: string;
  /** 読めなかった事 */
  failed: Failed;
}

/** 読めなかった事を、理由と問い合わせの番号と一緒に出す */
export function FailureAlert({ title, failed }: FailureAlertProps) {
  return (
    <Alert tone="error" title={title}>
      {failed.code === "network" ? "入口につながりません。" : `理由: ${failed.code}。`}
      {failed.traceId ? ` 問い合わせの番号: ${failed.traceId}` : null}
    </Alert>
  );
}

interface NoteFormProps {
  nodeId: string;
  path: string;
  line: DiffLine;
  onDone: (text: string) => void;
}

/** 1 行への指摘を書く欄。送ると作った社員のタスクに戻り、GitHub の行のコメントにも写る */
function NoteForm({ nodeId, path, line, onDone }: NoteFormProps) {
  const api = useContext(ApiContext);
  const [body, setBody] = useState("");
  const [failed, setFailed] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const side = line.type === "del" ? "old" : "new";
  const number = (side === "old" ? line.oldNumber : line.newNumber) ?? 1;
  const send = async () => {
    if (!api) return setFailed(NETWORK);
    setBusy(true);
    const res = await api.api.v1.reviews[":nodeId"].notes.$post({ param: { nodeId }, json: { path, line: number, side, body } }).catch(() => null);
    setBusy(false);
    if (res?.ok) return onDone(`${path} の ${String(number)} 行目に指摘を書き、作る役に戻しました`);
    setFailed(res ? await failureOf(res) : NETWORK);
  };
  return (
    <Stack gap={2}>
      <TextField label={`${path} の ${String(number)} 行目への指摘`} value={body} onChange={(e) => setBody(e.target.value)} multiline />
      <Stack direction="row" gap={2}>
        <Button variant="secondary" loading={busy} disabled={body.trim() === ""} onClick={() => void send()}>
          指摘を送る
        </Button>
      </Stack>
      {failed ? <FailureAlert title="指摘を送れませんでした" failed={failed} /> : null}
    </Stack>
  );
}

interface FileDiffPanelProps {
  nodeId: string;
  file: ReviewFile;
  since: string | null;
  head: string;
  range: WorkingRange | null;
  onNote: (text: string) => void;
}

/**
 * 行を見分ける印を作る。差分の行は描くたびに作り直されるので、物の同じさでなく種類と行の番号で比べる
 * @param line 差分の行
 * @returns 印
 */
function lineKey(line: DiffLine): string {
  return `${line.type}:${String(line.oldNumber ?? "")}:${String(line.newNumber ?? "")}`;
}

/** 1 ファイルの差分。開いた時に入口から読む */
function FileDiffPanel({ nodeId, file, since, head, range, onNote }: FileDiffPanelProps) {
  const loaded = useFileDiff(nodeId, file.path, since, head, range);
  const [target, setTarget] = useState<string | null>(null);
  if (loaded.state === "loading") return <p role="status">{file.path} の変更を読んでいます</p>;
  if (loaded.state === "failed") return <FailureAlert title={`${file.path} の変更を読めませんでした`} failed={loaded} />;
  if (loaded.data.hunks.length === 0) return <p>行の差はありません。大きすぎるファイルと文字でないファイルは、GitHub が行の差を返しません</p>;
  // 作業中の変更はプルリクエストの前なので、行の指摘を書く先が無い
  if (range !== null) return <DiffView files={[toDiffFile(loaded.data, file.status)]} />;
  return (
    <DiffView
      files={[toDiffFile(loaded.data, file.status)]}
      onLineComment={(_f, line) => setTarget(lineKey(line))}
      renderAfterLine={(_f, line) =>
        lineKey(line) === target ? (
          <NoteForm
            nodeId={nodeId}
            path={file.path}
            line={line}
            onDone={(text) => {
              setTarget(null);
              onNote(text);
            }}
          />
        ) : null
      }
    />
  );
}

export interface ReviewFilesProps {
  /** 作った社員のタスク ID */
  nodeId: string;
  /** 見せるファイル */
  files: readonly ReviewFile[];
  /** 前に見た先。あればそこからの差だけを読む */
  since: string | null;
  /** 今の先 */
  head: string;
  /** 作業中の変更の元と先。あれば差分はこの間を読み、行の指摘を出さない */
  range?: WorkingRange | null;
  /** 指摘を送れた時 */
  onNote: (text: string) => void;
}

/** 変えたファイルの木。最初のファイルだけを開いて読み、残りは開いた時に読む */
export function ReviewFiles({ nodeId, files, since, head, range = null, onNote }: ReviewFilesProps) {
  const [open, setOpen] = useState<string[]>(() => (files[0] ? [files[0].path] : []));
  if (files.length === 0) return <p>変えたファイルはありません</p>;
  return (
    <Accordion
      multiple
      value={open}
      onValueChange={setOpen}
      items={files.map((f) => ({
        value: f.path,
        title: (
          <Stack direction="row" gap={2} align="center" wrap>
            <span>{f.path}</span>
            <Badge>{STATUS_LABEL[f.status]}</Badge>
            {f.seen ? null : <Badge tone="info">未読</Badge>}
          </Stack>
        ),
        content: open.includes(f.path) ? <FileDiffPanel nodeId={nodeId} file={f} since={since} head={head} range={range} onNote={onNote} /> : null,
      }))}
    />
  );
}
