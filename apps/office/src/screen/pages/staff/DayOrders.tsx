// その日だけの指示。今日の勤務の変更 (延長、早退、休み) を、終了時刻を時と分で選んで登録し、登録した物を並べて取り消せるようにする。延長はパスキーで確かめる (社員と勤怠の 3.4)
import type { Order, OrderKind, StaffOverview } from "@know-office/core";
import { DAY_ORDER_KINDS } from "@know-office/core/master/day-order-kinds";
import { labelOf, optionsOf } from "@know-office/core/master/master";
import { Alert, Button, List, SegmentedControl, Select, Stack } from "knowidea-ui";
import { useContext, useId, useState } from "react";
import { ApiContext } from "../../api.ts";
import { jstTime } from "../../format.ts";
import { type Failed, FailedAlert, type Loaded, send } from "../../parts/load.tsx";

/** 時の選び肢 00 から 23 */
const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).map((v) => ({ value: v, label: v }));
/** 分の選び肢 00 から 59。早退の時刻を分まで決められるよう 1 分ごとに並べる */
const MINUTES = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0")).map((v) => ({ value: v, label: v }));

type Kind = OrderKind;
const isKind = (v: string): v is Kind => DAY_ORDER_KINDS.some((k) => k.value === v);

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
  const hintId = useId();
  const [hour, setHour] = useState("19");
  const [minute, setMinute] = useState("00");
  const until = `${hour}:${minute}`;
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
    const text = kind === "off" ? `${staff.role}を今日は休みにしました` : `${staff.role}の今日の${labelOf(DAY_ORDER_KINDS, kind)}を登録しました。終了時刻は ${until} です`;
    void run("create", text, () => api.api.v1.staff[":staffId"].orders.$post({ param: { staffId: staff.id }, json }));
  };
  const orders = loaded.state === "ok" ? loaded.data : [];
  return (
    <Stack gap={3}>
      <SegmentedControl label="今日だけの指示" value={kind} onValueChange={(v) => isKind(v) && setKind(v)} options={optionsOf(DAY_ORDER_KINDS)} />
      {kind === "off" ? null : (
        // 時と分の 2 つの欄を 1 つの名前でまとめる。Field で包むと両方の欄が同じ名前になり、どちらか分からないため
        <fieldset className="ki-fieldset" aria-describedby={hintId}>
          <legend>終了時刻</legend>
          <Stack direction="row" gap={2} align="center">
            <Select aria-label="終了時刻の時" value={hour} options={HOURS} onValueChange={(v) => v !== null && setHour(v)} />
            <span aria-hidden="true">:</span>
            <Select aria-label="終了時刻の分" value={minute} options={MINUTES} onValueChange={(v) => v !== null && setMinute(v)} />
          </Stack>
          <p className="ki-field__hint" id={hintId}>
            {kind === "extend" ? "時と分を選びます。延長はパスキーで確かめます" : "時と分を選びます"}
          </p>
        </fieldset>
      )}
      <Stack direction="row" gap={2}>
        <Button variant="secondary" loading={busy === "create"} disabled={busy !== null} onClick={submit}>
          変更を登録する
        </Button>
      </Stack>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="勤務を変更できませんでした" failure={failure} /> : null}
      {loaded.state === "failed" ? <FailedAlert title="指示を読めませんでした" failure={loaded} /> : null}
      <List
        label={`${staff.role}への今日の指示`}
        state={loaded.state === "loading" ? "loading" : (orders.length === 0 ? "empty" : "ready")}
        loadingText="指示を読んでいます"
        emptyText="今日の指示はありません"
        items={orders.map((o) => ({
          id: o.id,
          title: o.until === null ? labelOf(DAY_ORDER_KINDS, o.kind) : `${labelOf(DAY_ORDER_KINDS, o.kind)} 終了 ${o.until}`,
          meta: o.cancelledAt === null ? `${jstTime(o.createdAt)} に登録` : `${jstTime(o.cancelledAt)} に取り消し`,
          side:
            o.cancelledAt === null && api ? (
              <Button
                variant="quiet"
                aria-label={`${labelOf(DAY_ORDER_KINDS, o.kind)}の指示を取り消す`}
                loading={busy === o.id}
                disabled={busy !== null}
                onClick={() => void run(o.id, `${labelOf(DAY_ORDER_KINDS, o.kind)}の指示を取り消しました`, () => api.api.v1.staff[":staffId"].orders[":orderId"].$delete({ param: { staffId: staff.id, orderId: o.id } }))}
              >
                取り消す
              </Button>
            ) : undefined,
        }))}
      />
    </Stack>
  );
}
