// 案を足す。名前、種類、狙い、使う人、月の費用と売り上げの見込みを書き、アイデアの段階に足す (サービスと拡張の 3.1)
import { CreateIdeaInput, ServiceCard, ServiceKind } from "@know-office/core";
import { Button, Field, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";
import { KIND_LABEL } from "./labels.ts";

export interface IdeaFormProps {
  /** 足した後に呼ぶ。足した案を渡す */
  onAdded: (card: ServiceCard) => void;
}

const EMPTY = { title: "", kind: "web_app" as ServiceKind, aim: "", users: "", cost: "0", revenue: "0" };

/**
 * ドルの文を 100 万分の 1 ドルの整数にする。読めなければ null
 * @param text 入れた文
 * @returns 100 万分の 1 ドル
 */
function microUsd(text: string): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null;
}

/** 案を足す欄 */
export function IdeaForm({ onAdded }: IdeaFormProps) {
  const api = useContext(ApiContext);
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const cost = microUsd(draft.cost);
  const revenue = microUsd(draft.revenue);
  const input = CreateIdeaInput.safeParse({ title: draft.title.trim(), kind: draft.kind, aim: draft.aim.trim(), users: draft.users.trim(), costEstimateMicroUsd: cost, revenueEstimateMicroUsd: revenue });

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
    onAdded(z.object({ data: ServiceCard }).loose().parse(await sent.res.json()).data);
  };

  return (
    <Stack gap={3}>
      <TextField label="案の名前" value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      <Field label="種類">
        <Select
          aria-label="種類"
          value={draft.kind}
          options={ServiceKind.options.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          onValueChange={(v) => {
            const kind = ServiceKind.safeParse(v);
            if (kind.success) setDraft({ ...draft, kind: kind.data });
          }}
        />
      </Field>
      <TextField label="狙い" multiline rows={3} value={draft.aim} maxLength={2000} onChange={(e) => setDraft({ ...draft, aim: e.target.value })} />
      <TextField label="使う人" value={draft.users} maxLength={500} onChange={(e) => setDraft({ ...draft, users: e.target.value })} />
      <Stack direction="row" gap={3} wrap>
        <TextField label="月の費用の見込み (ドル)" inputMode="decimal" value={draft.cost} error={cost === null ? "0 以上の数を入れる" : undefined} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
        <TextField label="月の売り上げの見込み (ドル)" inputMode="decimal" value={draft.revenue} error={revenue === null ? "0 以上の数を入れる" : undefined} onChange={(e) => setDraft({ ...draft, revenue: e.target.value })} />
      </Stack>
      <Stack direction="row" gap={2}>
        <Button loading={busy} disabled={!input.success} onClick={() => void add()}>
          案を足す
        </Button>
      </Stack>
      {failure ? <FailedAlert title="案を足せませんでした" failure={failure} /> : null}
    </Stack>
  );
}
