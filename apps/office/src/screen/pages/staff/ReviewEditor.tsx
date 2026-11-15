// レビューのその場の直し。今の先のファイルを knowidea-ui のエディタで書き換え、同じブランチにコミットする (タスクとレビューの 3.6)
import { Button, Stack, TextField, editorLanguageOfPath } from "knowidea-ui";
import { Suspense, lazy, useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, failureOf, NETWORK, useLoad } from "./review-load.ts";
import { FailureAlert } from "./ReviewFiles.tsx";

// エディタは「直す」を押した時だけ読み込む
const CodeEditor = lazy(() => import("knowidea-ui/editor").then((m) => ({ default: m.CodeEditor })));

export interface ReviewEditorProps {
  /** 作った社員のタスク ID */
  nodeId: string;
  /** 書き換えるファイルの道 */
  path: string;
  /** 読んだ時の先。コミットの親になり、進んでいれば 409 */
  head: string;
  /** コミットできた時。新しい先を読み直す */
  onCommitted: (text: string) => void;
}

/** 1 ファイルを書き換えてコミットする欄 */
export function ReviewEditor({ nodeId, path, head, onCommitted }: ReviewEditorProps) {
  const api = useContext(ApiContext);
  const loaded = useLoad(`${nodeId}/${path}/${head}`, async (a) => {
    const res = await a.api.v1.reviews[":nodeId"].file.$get({ param: { nodeId }, query: { path, ref: "head" } });
    return res.ok ? (await res.json()).data.content : failureOf(res);
  });
  const [text, setText] = useState<string | null>(null);
  const [message, setMessage] = useState(`${path} を直す`);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  if (loaded.state === "loading") return <p role="status">{path} を読んでいます</p>;
  if (loaded.state === "failed") return <FailureAlert title={`${path} を読めませんでした`} failed={loaded} />;
  const value = text ?? loaded.data;
  const commit = async () => {
    if (!api) return setFailed(NETWORK);
    setBusy(true);
    const res = await api.api.v1.reviews[":nodeId"].commits.$post({ param: { nodeId }, json: { path, content: value, baseSha: head, message } }).catch(() => null);
    setBusy(false);
    if (res?.ok) return onCommitted(`${path} をコミットしました`);
    setFailed(res ? await failureOf(res) : NETWORK);
  };
  return (
    <Stack gap={3}>
      <Suspense fallback={<p role="status">エディタを読み込んでいます</p>}>
        <CodeEditor label={path} value={value} onChange={setText} language={editorLanguageOfPath(path)} onSave={() => void commit()} />
      </Suspense>
      <TextField label="コミットの文" value={message} onChange={(e) => setMessage(e.target.value)} />
      <Stack direction="row" gap={2}>
        <Button loading={busy} disabled={message.trim() === "" || text === null} onClick={() => void commit()}>
          コミットする
        </Button>
      </Stack>
      {failed ? <FailureAlert title="コミットできませんでした" failed={failed} /> : null}
    </Stack>
  );
}
