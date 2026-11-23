// 案を足すダイアログ。名前と一言だけを書き、アイデアの段階に足す。種類、使う人、見込みは後から元の案で選ぶ (サービスと拡張の 3.1)
import { CreateIdeaInput, ServiceCard } from "@know-office/core";
import { Button, Dialog, DialogClose, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";

export interface IdeaFormProps {
  /** 足した後に呼ぶ。足した案を渡す */
  onAdded: (card: ServiceCard) => void;
}

const EMPTY = { title: "", aim: "" };

/** 一覧の上の追加ボタンと、案を足すダイアログ */
export function IdeaForm({ onAdded }: IdeaFormProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const input = CreateIdeaInput.safeParse({ title: draft.title.trim(), aim: draft.aim.trim() });

  const add = async () => {
    if (!api || !input.success) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.services.$post({ json: input.data }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setDraft(EMPTY);
    setOpen(false);
    onAdded(z.object({ data: ServiceCard }).loose().parse(await sent.res.json()).data);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFailure(undefined);
      }}
      trigger={<Button>追加</Button>}
      title="案を追加する"
      description="名前と一言だけで足せます。種類、使う人、見込みは、足した後に元の案のタブで選びます"
      actions={
        <>
          <DialogClose variant="secondary">やめる</DialogClose>
          <Button loading={busy} disabled={!input.success} onClick={() => void add()}>
            追加する
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <TextField label="名前" value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <TextField label="一言" hint="何を良くする案か" value={draft.aim} maxLength={2000} onChange={(e) => setDraft({ ...draft, aim: e.target.value })} />
        {failure ? <FailedAlert title="案を追加できませんでした" failure={failure} /> : null}
      </Stack>
    </Dialog>
  );
}
