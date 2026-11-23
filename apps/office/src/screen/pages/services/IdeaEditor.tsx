// 元の案のタブ。名前、種類、一言、使う人、月の見込みを出し、編集を押すとその場で選ぶ欄になり、保存で直す (サービスと拡張の 3.1)
import { type ServiceDetail, ServiceKind, UpdateServiceInput } from "@know-office/core";
import { optionsOf } from "@know-office/core/master/master";
import { SERVICE_COST_ESTIMATES } from "@know-office/core/master/service-cost-estimates";
import { SERVICE_KINDS } from "@know-office/core/master/service-kinds";
import { SERVICE_REVENUE_ESTIMATES } from "@know-office/core/master/service-revenue-estimates";
import { SERVICE_USERS } from "@know-office/core/master/service-users";
import { Alert, Button, Field, List, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";
import { dollars, UNSET } from "./labels.ts";

/** 種類を直せる段階。作ると決めた後は入口が断る */
const KIND_EDITABLE = new Set<string>(["idea", "study"]);

/**
 * 選び肢を、今の値が並びに無ければ頭に足して選ぶ欄の項目にする。入口は並びに無い値も受けるので、前に入れた値も選んだまま出す
 * @param options マスタデータの選び肢
 * @param now 今の値。空なら足さない
 * @param label 今の値の名前
 * @returns 選ぶ欄の項目
 */
function withCurrent(options: { value: string; label: string }[], now: string, label: string): { value: string; label: string }[] {
  return now === "" || options.some((o) => o.value === now) ? options : [{ value: now, label }, ...options];
}

export interface IdeaEditorProps {
  /** 直すサービス */
  service: ServiceDetail;
  /** 保存した後に呼ぶ。一覧と詳細を読み直す */
  onSaved: () => void;
}

/** 元の案。見る時は一覧、編集の時は選ぶ欄 */
export function IdeaEditor({ service: s, onSaved }: IdeaEditorProps) {
  const api = useContext(ApiContext);
  const start = { title: s.name, kind: s.kind, aim: s.aim, users: s.users, cost: s.costEstimateMicroUsd, revenue: s.revenueEstimateMicroUsd };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(start);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const [saved, setSaved] = useState(false);

  // 変えた項目だけを送る。同じ時にほかの所で直した項目を上書きしない
  const changed = {
    ...(draft.title.trim() === s.name ? {} : { title: draft.title.trim() }),
    ...(draft.kind === s.kind ? {} : { kind: draft.kind }),
    ...(draft.aim.trim() === s.aim ? {} : { aim: draft.aim.trim() }),
    ...(draft.users === s.users ? {} : { users: draft.users }),
    ...(draft.cost === s.costEstimateMicroUsd ? {} : { costEstimateMicroUsd: draft.cost }),
    ...(draft.revenue === s.revenueEstimateMicroUsd ? {} : { revenueEstimateMicroUsd: draft.revenue }),
  };
  const input = UpdateServiceInput.safeParse(changed);

  const save = async () => {
    if (!api || !input.success) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.services[":serviceId"].$patch({ param: { serviceId: s.id }, json: input.data }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setEditing(false);
    setSaved(true);
    onSaved();
  };

  const rows = [
    { id: "aim", title: "一言", meta: s.aim },
    { id: "users", title: "使う人", meta: s.users === "" ? UNSET : s.users },
    { id: "cost", title: "月の費用の見込み", meta: dollars(s.costEstimateMicroUsd) },
    { id: "revenue", title: "月の売り上げの見込み", meta: dollars(s.revenueEstimateMicroUsd) },
    { id: "study", title: "検討の材料", meta: s.study ?? UNSET },
    ...(s.droppedReason === null ? [] : [{ id: "dropped", title: "見送った理由", meta: s.droppedReason }]),
  ];

  if (!editing) {
    return (
      <Stack gap={3}>
        {saved ? (
          <Alert tone="success" live>
            元の案を保存しました
          </Alert>
        ) : null}
        <List label={`${s.name}の元の案`} items={rows} />
        <Stack direction="row" justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(start);
              setSaved(false);
              setEditing(true);
            }}
          >
            編集
          </Button>
        </Stack>
      </Stack>
    );
  }

  const kindEditable = KIND_EDITABLE.has(s.stage);
  return (
    <Stack gap={3}>
      <TextField label="名前" value={draft.title} maxLength={100} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      <Field label="種類" hint={kindEditable ? undefined : "作ると決めた後は変えられません"}>
        <Select
          aria-label="種類"
          value={draft.kind}
          disabled={!kindEditable}
          options={optionsOf(SERVICE_KINDS)}
          onValueChange={(v) => {
            const kind = ServiceKind.safeParse(v);
            if (kind.success) setDraft({ ...draft, kind: kind.data });
          }}
        />
      </Field>
      <TextField label="一言" value={draft.aim} maxLength={2000} onChange={(e) => setDraft({ ...draft, aim: e.target.value })} />
      <Field label="使う人">
        <Select aria-label="使う人" value={draft.users === "" ? null : draft.users} placeholder="選ぶ" options={withCurrent(optionsOf(SERVICE_USERS), s.users, s.users)} onValueChange={(v) => setDraft({ ...draft, users: v ?? "" })} />
      </Field>
      <Field label="月の費用の見込み">
        <Select aria-label="月の費用の見込み" value={String(draft.cost)} options={withCurrent(optionsOf(SERVICE_COST_ESTIMATES), String(s.costEstimateMicroUsd), dollars(s.costEstimateMicroUsd))} onValueChange={(v) => setDraft({ ...draft, cost: Number(v ?? draft.cost) })} />
      </Field>
      <Field label="月の売り上げの見込み">
        <Select
          aria-label="月の売り上げの見込み"
          value={String(draft.revenue)}
          options={withCurrent(optionsOf(SERVICE_REVENUE_ESTIMATES), String(s.revenueEstimateMicroUsd), dollars(s.revenueEstimateMicroUsd))}
          onValueChange={(v) => setDraft({ ...draft, revenue: Number(v ?? draft.revenue) })}
        />
      </Field>
      {failure ? <FailedAlert title="元の案を保存できませんでした" failure={failure} /> : null}
      <Stack direction="row" gap={2} justify="end">
        <Button variant="secondary" onClick={() => setEditing(false)}>
          やめる
        </Button>
        <Button loading={busy} disabled={!input.success} onClick={() => void save()}>
          保存
        </Button>
      </Stack>
    </Stack>
  );
}
