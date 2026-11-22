// 目的と組織図の画面で、オーナーが目的、目標、プロジェクトを置く。タスクは TaskDialogs.tsx で足す (タスクとレビューの 3.1、API の nodes)
import type { NodeTree } from "@know-office/core";
import { Button, Dialog, DialogClose, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";

/** オーナーが画面で置ける、タスクの上の種類 */
type UpperKind = "purpose" | "goal" | "project";

const UPPER_LABEL: Record<UpperKind, string> = { purpose: "目的", goal: "目標", project: "プロジェクト" };

/** 親の種類ごとに、その下に置く種類 */
const CHILD_OF = { purpose: "goal", goal: "project" } as const satisfies Partial<Record<UpperKind, UpperKind>>;

interface AddNodeProps {
  /** 置く物の親。無ければ目的を置く。目的の下には目標、目標の下にはプロジェクトを置く。ほかの種類の親には何も出さない */
  parent?: NodeTree | undefined;
  /** 置いた後に呼ぶ。木を読み直すのに使う */
  onDone: () => void;
}

/**
 * 置く物の種類とボタンの名前を決める
 * @param parent 親。無ければ目的
 * @returns 種類と名前。親の下に置ける物が無ければ null
 */
function addingOf(parent: AddNodeProps["parent"]): { kind: UpperKind; name: string } | null {
  if (!parent) return { kind: "purpose", name: "目的を足す" };
  if (parent.kind !== "purpose" && parent.kind !== "goal") return null;
  const kind = CHILD_OF[parent.kind];
  return { kind, name: `「${parent.title}」に${UPPER_LABEL[kind]}を足す` };
}

/** 目的、目標、プロジェクトを置くボタンとダイアログ。題と本文を入れ、親と同じ範囲に置く */
export function AddNode({ parent, onDone }: AddNodeProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const adding = addingOf(parent);

  const reset = () => {
    setTitle("");
    setBody("");
    setFailure(undefined);
  };

  const submit = async () => {
    if (!api || !adding || busy || title.trim() === "") return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () =>
      api.api.v1.nodes.$post({
        json: {
          kind: adding.kind,
          scope: parent?.scope ?? "office",
          title: title.trim(),
          ...(parent ? { parentId: parent.id } : {}),
          ...(body.trim() === "" ? {} : { body: body.trim() }),
        },
      }),
    );
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setOpen(false);
    reset();
    onDone();
  };

  if (!adding) return null;
  const { kind, name } = adding;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) reset();
      }}
      trigger={<Button variant={parent ? "quiet" : "secondary"}>{name}</Button>}
      title={name}
      description={kind === "purpose" ? "社長は目的と目標から、プロジェクトとタスクに分けて社員に割り振ります。" : `${UPPER_LABEL[kind]}は「${parent?.title ?? ""}」の下に置きます。`}
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} disabled={title.trim() === ""} onClick={() => void submit()}>
            {`${UPPER_LABEL[kind]}を足す`}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <TextField label="題" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextField label="本文" multiline rows={4} maxLength={20_000} value={body} onChange={(e) => setBody(e.target.value)} />
        {failure ? <FailedAlert title={`${UPPER_LABEL[kind]}を足せませんでした`} failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}
