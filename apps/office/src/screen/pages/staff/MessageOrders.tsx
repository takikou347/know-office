// オーナーの発言から足した勤務の指示を、発言の下に並べて取り消せるようにする (社員と勤怠の 3.4)
import type { MessageOrder, SkippedOrder, StaffOverview } from "@know-office/core";
import { DAY_ORDER_KINDS } from "@know-office/core/master/day-order-kinds";
import { labelOf } from "@know-office/core/master/master";
import { Button, Stack } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";

/**
 * YYYY-MM-DD を M/D にする
 * @param day 日本時間の日
 * @returns M/D
 */
function shortDay(day: string): string {
  const [, m = "", d = ""] = day.split("-");
  return `${String(Number(m))}/${String(Number(d))}`;
}

/**
 * 足した指示の文。日と時刻を付ける
 * @param o 指示
 * @returns 文
 */
function addedText(o: MessageOrder): string {
  if (o.until === null) return `${shortDay(o.day)} を休みにしました`;
  return `${shortDay(o.day)} の${labelOf(DAY_ORDER_KINDS, o.kind)}を登録しました。終了時刻は ${o.until} です`;
}

export interface MessageOrdersProps {
  /** 指示を出した社員 */
  staff: StaffOverview;
  /** 発言から足した指示と、足さなかった延長 */
  orders: readonly (MessageOrder | SkippedOrder)[];
}

/**
 * 発言から足した指示と、取り消すボタン
 * @param props 社員と指示
 * @returns 指示の並び。指示が無ければ null
 */
export function MessageOrders({ staff, orders }: MessageOrdersProps) {
  const api = useContext(ApiContext);
  // 取り消した指示。読み直すまでの間もボタンを消す
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failed>();
  const [gone, setGone] = useState(false);
  if (orders.length === 0) return null;
  const cancel = async (o: MessageOrder) => {
    if (!api) return;
    setBusy(o.id);
    setFailure(undefined);
    setGone(false);
    const sent = await send(api, () => api.api.v1.staff[":staffId"].orders[":orderId"].$delete({ param: { staffId: staff.id, orderId: o.id } }));
    setBusy(null);
    if (sent.ok || sent.failure.code === "conflict") setCancelled((before) => new Set(before).add(o.id));
    if (!sent.ok && sent.failure.code === "conflict") setGone(true);
    else if (!sent.ok) setFailure(sent.failure);
  };
  return (
    <Stack gap={1}>
      {orders.map((o) =>
        "skipped" in o ? (
          <span key={`skipped:${o.day}:${o.until}`}>{`${shortDay(o.day)} の延長 (${o.until} まで) はパスキーの確認が要るので出していません。指示のボタンから出してください`}</span>
        ) : (
          <Stack key={o.id} direction="row" gap={2} wrap align="center">
            <span>{o.cancelledAt !== null || cancelled.has(o.id) ? `${addedText(o)} (取り消しました)` : addedText(o)}</span>
            {o.cancelledAt === null && !cancelled.has(o.id) && api ? (
              <Button variant="secondary" aria-label={`${labelOf(DAY_ORDER_KINDS, o.kind)}の指示を取り消す`} loading={busy === o.id} disabled={busy !== null} onClick={() => void cancel(o)}>
                取り消す
              </Button>
            ) : null}
          </Stack>
        ),
      )}
      {/* 読み上げの入れ物は先に置き、中身だけを入れ替える */}
      <span role="status">{gone ? "もう取り消されています" : ""}</span>
      {failure ? <FailedAlert title="指示を取り消せませんでした" failure={failure} /> : null}
    </Stack>
  );
}
