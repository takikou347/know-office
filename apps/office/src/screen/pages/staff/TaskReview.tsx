// 仮のデータのタスクのレビュー。可と不可は画面の中の置き場だけを変え、記録には残さない。入口にレビューのあるタスクは ReviewPage が出す
import { Button, DiffView, Link, Stack, Status, Timeline, parseUnifiedDiff } from "knowidea-ui";
import { Suspense, lazy, useState } from "react";
import { type Task, flows } from "../../mock.ts";
import { Done, Part } from "../../parts/section.tsx";
import { TASK_KIND, roleOf } from "../../parts/tasks.ts";
import { workFeed } from "../office/feed.ts";

// エディタは「直す」を押した時だけ読み込む
const CodeEditor = lazy(() => import("knowidea-ui/editor").then((m) => ({ default: m.CodeEditor })));

export interface TaskReviewProps {
  /** 確かめるタスク */
  task: Task;
}

export function TaskReview({ task }: TaskReviewProps) {
  const [done, setDone] = useState<string>();
  const [editing, setEditing] = useState(false);
  const files = task.diff ? parseUnifiedDiff(task.diff) : [];
  const first = files[0];
  const [text, setText] = useState(() =>
    (first?.hunks ?? []).flatMap((h) => h.lines.filter((l) => l.type !== "del").map((l) => l.text)).join("\n"),
  );
  return (
    <Stack gap={4}>
      <Link href={`/staff/${task.staffId}?tab=tasks`} standalone>
        仕事の山に戻る
      </Link>
      <h2>{task.title}</h2>
      <Stack direction="row" gap={2} align="center" wrap>
        <Status kind={TASK_KIND[task.state]} label={task.state} />
        <span>
          {roleOf(task.staffId)}、{task.service}
        </span>
      </Stack>
      <Part title="作業の流れ">
        <Timeline items={flows[task.id] ?? []} emptyText="流れはまだ無い" />
      </Part>
      <Part title="変更">
        {files.length > 0 ? <DiffView files={files} /> : <p>変更はまだ無い</p>}
        {first && editing ? (
          <Suspense fallback={<p>エディタを読み込んでいます</p>}>
            <CodeEditor label={first.path} value={text} onChange={setText} language="typescript" />
          </Suspense>
        ) : null}
      </Part>
      <Done text={done} />
      <Stack direction="row" gap={2} wrap>
        <Button
          onClick={() => {
            setDone("可を出しました");
            workFeed.setTaskState(task.id, "済");
          }}
        >
          可
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setDone("不可を出し、作る役に戻しました");
            workFeed.setTaskState(task.id, "今");
          }}
        >
          不可
        </Button>
        {first ? (
          <Button variant="quiet" onClick={() => setEditing((v) => !v)}>
            {editing ? "直すのをやめる" : "直す"}
          </Button>
        ) : null}
      </Stack>
    </Stack>
  );
}
