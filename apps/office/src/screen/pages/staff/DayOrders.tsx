// その日だけの指示。今日の延長、早退、休みを出し、出した指示を並べて取り消せるようにする。延長はパスキーで確かめる (社員と勤怠の 3.4)
import type { Order, StaffOverview } from "@know-office/core";
import { Alert, Button, List, SegmentedControl, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { jstTime } from "../../format.ts";
import { type Failed, FailedAlert, type Loaded, send } from "../../parts/load.tsx";

/** 指示の種類と言葉 */
const KINDS = [
  { value: "extend", label: "延長" },
  { value: "leave_early", label: "早退" },
  { value: "off", label: "休み" },
] as const;

type Kind = (typeof KINDS)[number]["value"];
const isKind = (v: string): v is Kind => KINDS.some((k) => k.value === v);
const labelOf = (kind: Kind) => KINDS.find((k) => k.value === kind)?.label ?? kind;

export interface DayOrdersProps {
  /** 指示を出す社員 */
  staff: StaffOverview;
  /** 日本時間の今日 (YYYY-MM-DD)。指示はこの日に出す */
  day: string;
  /** 今日の指示を読んだ物。社員の様子が読み、読み終えてからタブを出す */
  orders: Loaded<Order[]>;
  /** 指示を出した、取り消した後に読み直させる */
  onChanged: () => void;
}

/**
 * 今日だけの指示を出す欄と、出した指示の一覧
 * @param props 指示を出す社員、今日、読んだ指示、読み直させる口
 * @returns 指示の欄
 */
export function DayOrders({ staff, day, orders: loaded, onChanged }: DayOrdersProps) {
  const api = useContext(ApiContext);
  const [kind, setKind] = useState<Kind>("extend");
  const [until, setUntil] = useState("19:00");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();
  const run = async (key: string, text: string, call: () => Promise<Response>) => {
    if (!api) return;
    setBusy(key);
    setDone(undefined);
    setFailure(undefined);
    const sent = await send(api, call);
    setBusy(null);
    if (sent.ok) setDone(text);
    else setFailure(sent.failure);
    onChanged();
  };
  const submit = () => {
    if (!api) return;
    const json = kind === "off" ? { day, kind } : { day, kind, until };
    const text = kind === "off" ? `${staff.role}を今日は休みにしました` : `${staff.role}に今日の${labelOf(kind)}を ${until} までで出しました`;
    void run("create", text, () => api.api.v1.staff[":staffId"].orders.$post({ param: { staffId: staff.id }, json }));
  };
  const orders = loaded.state === "ok" ? loaded.data : [];
  return (
    <Stack gap={3}>
      <SegmentedControl label="今日だけの指示" value={kind} onValueChange={(v) => isKind(v) && setKind(v)} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
      {/* Chrome の type="time" は時計のボタンに focus の輪が出ないので、24 時間の文字で受ける。形はゲートウェイが確かめる */}
      {kind === "off" ? null : (
        <TextField
          label="終わりの時刻"
          inputMode="numeric"
          autoComplete="off"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          hint={kind === "extend" ? "24 時間の 時:分 で入れます。延長はパスキーで確かめます" : "24 時間の 時:分 で入れます"}
        />
      )}
      <Stack direction="row" gap={2}>
        <Button variant="secondary" loading={busy === "create"} disabled={busy !== null} onClick={submit}>
          指示を出す
        </Button>
      </Stack>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="指示を出せませんでした" failure={failure} /> : null}
      {loaded.state === "failed" ? <FailedAlert title="指示を読めませんでした" failure={loaded} /> : null}
      <List
        label={`${staff.role}への今日の指示`}
        state={loaded.state === "loading" ? "loading" : (orders.length === 0 ? "empty" : "ready")}
        loadingText="指示を読んでいます"
        emptyText="今日の指示は無い"
        items={orders.map((o) => ({
          id: o.id,
          title: o.until === null ? labelOf(o.kind) : `${labelOf(o.kind)} ${o.until} まで`,
          meta: o.cancelledAt === null ? `${jstTime(o.createdAt)} に出した` : `${jstTime(o.cancelledAt)} に取り消した`,
          side:
            o.cancelledAt === null && api ? (
              <Button
                variant="quiet"
                aria-label={`${labelOf(o.kind)}の指示を取り消す`}
                loading={busy === o.id}
                disabled={busy !== null}
                onClick={() => void run(o.id, `${labelOf(o.kind)}の指示を取り消しました`, () => api.api.v1.staff[":staffId"].orders[":orderId"].$delete({ param: { staffId: staff.id, orderId: o.id } }))}
              >
                取り消す
              </Button>
            ) : undefined,
        }))}
      />
    </Stack>
  );
}
