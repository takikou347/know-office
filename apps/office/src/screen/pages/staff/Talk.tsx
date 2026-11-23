// 社員との会話。入口から新しい順に読んで古い順に並べ、配信で届いた発言を足し、オーナーの言葉を送り、社員に渡ったかと社長のタスクにしたかを出す (社員と自動の 3.7、社員が考えるの 3.9、タスクとレビューの 3.1 の 7)
import { Message, type MessageDelivery, type MessageOrder, type SkippedOrder, type StaffOverview } from "@know-office/core";
import { Badge, Button, Conversation, Field, Link, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { jstTime } from "../../format.ts";
import { useLiveEvent, useLiveTick } from "../../parts/live.tsx";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { taskHref } from "../../parts/tasks.ts";
import { MessageOrders } from "./MessageOrders.tsx";

/** 1 度に読む発言の数 */
const MESSAGE_PAGE = "50";

/** オーナーの発言が社員に渡ったかの表示。null はまだ渡していない */
const DELIVERY_LABEL: Record<MessageDelivery | "pending", string> = {
  run: "社員に渡しました",
  next_task: "次のタスクの頭で渡しました",
  task: "タスクにしました",
  skipped: "渡していません",
  pending: "次のタスクで渡します",
};

/** 渡ったかの表示の色。渡していない物だけを目立たせる */
const DELIVERY_TONE: Record<MessageDelivery | "pending", "neutral" | "success" | "warn"> = { run: "success", next_task: "success", task: "success", skipped: "warn", pending: "neutral" };

/** 渡した道と、タスクにした時の足したタスク */
export type Delivered = { via: MessageDelivery; taskId: string | null };

export interface TalkProps {
  /** 話す社員 */
  staff: StaffOverview;
}

/** 頼みを入れる所の選ぶ欄の、office 全体の値 */
const OFFICE = "office";

const ServiceNames = z.array(z.object({ id: z.string(), name: z.string() }).loose());

/**
 * 頼みを入れられるサービスを読む。読めない間は空で、office 全体だけを選べる
 * @returns サービスの ID と名前
 */
function useServices(): { id: string; name: string }[] {
  const loaded = useLoad(ServiceNames, (a) => a.api.v1.services.$get({ query: { limit: "100" } }));
  return loaded.state === "ok" ? loaded.data : [];
}

/**
 * 社員との会話と、言葉を送る欄
 * @param props 話す社員
 * @returns 会話
 */
export function Talk({ staff }: TalkProps) {
  const api = useContext(ApiContext);
  // 本文を切った発言は、入口から読み直して全文を出す
  const tick = useLiveTick((e) => e.type === "message" && e.message.staffId === staff.id && e.message.truncated);
  const loaded = useLoad(z.array(Message), (a) => a.api.v1.staff[":staffId"].messages.$get({ param: { staffId: staff.id }, query: { limit: MESSAGE_PAGE } }), tick);
  const [arrived, setArrived] = useState<Message[]>([]);
  useLiveEvent((e) => {
    if (e.type !== "message" || e.message.staffId !== staff.id || e.message.truncated) return;
    const { truncated: _, ...message } = e.message;
    setArrived((before) => (before.some((m) => m.id === message.id) ? before : [...before, { ...message, deliveredAt: null, delivery: null, orders: [], taskId: null }]));
  });
  // 渡した印は発言より先に届く事もあるので、ID ごとに覚えておき、読み直した後も重ねて出す
  const [delivered, setDelivered] = useState<ReadonlyMap<string, Delivered>>(new Map());
  useLiveEvent((e) => {
    if (e.type !== "message_delivered") return;
    setDelivered((before) => new Map(before).set(e.delivery.id, { via: e.delivery.via, taskId: e.delivery.taskId }));
  });
  const [text, setText] = useState("");
  const [scope, setScope] = useState(OFFICE);
  const services = useServices();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  if (loaded.state === "loading") return <p role="status">会話を読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="会話を読めませんでした" failure={loaded} />;
  const byId = new Map([...loaded.data, ...arrived].map((m) => [m.id, m]));
  // ID は UUID v7 で時刻の順に並ぶ
  const shown = [...byId.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  const submit = async () => {
    if (!api || text.trim() === "") return;
    setBusy(true);
    setFailure(undefined);
    const serviceId = services.find((x) => x.id === scope)?.id;
    const sent = await send(api, () => api.api.v1.staff[":staffId"].messages.$post({ param: { staffId: staff.id }, json: serviceId === undefined ? { body: text } : { body: text, serviceId } }));
    setBusy(false);
    if (!sent.ok) return setFailure(sent.failure);
    const made = z.object({ data: Message }).loose().parse(await sent.res.json()).data;
    setArrived((before) => [...before.filter((m) => m.id !== made.id), made]);
    setText("");
  };
  return (
    <Stack gap={3}>
      <Conversation
        label={`${staff.role}との会話`}
        messages={shown.map((m) => ({
          id: m.id,
          from: m.sender === "owner" ? "self" : "other",
          author: m.sender === "owner" ? "オーナー" : staff.role,
          time: m.at,
          timeLabel: jstTime(m.at),
          body: m.sender === "owner" ? <OwnerBody staff={staff} body={m.body} delivery={delivered.get(m.id) ?? (m.delivery === null ? null : { via: m.delivery, taskId: m.taskId })} orders={m.orders} /> : m.body,
        }))}
        empty={<p>まだ話していない</p>}
      />
      <TextField
        label={`${staff.role}への言葉`}
        hint={talkHint(staff)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        multiline
      />
      <Field label="頼みを入れる所" hint="サービスの頼みは、そのサービスのタスクになります">
        <Select aria-label="頼みを入れる所" options={[{ value: OFFICE, label: "office 全体" }, ...services.map((x) => ({ value: x.id, label: x.name }))]} value={scope} onValueChange={(v) => setScope(v ?? OFFICE)} />
      </Field>
      <Stack direction="row" gap={2} justify="end">
        <Button loading={busy} disabled={busy || text.trim() === ""} onClick={() => void submit()}>
          送る
        </Button>
      </Stack>
      {failure ? <FailedAlert title="言葉を送れませんでした" failure={failure} /> : null}
    </Stack>
  );
}

/**
 * 会話の入力の説明。社員への言葉は、走っていない時にその社員のタスクになる
 * @param staff 話す社員
 * @returns 説明
 */
export function talkHint(staff: Pick<StaffOverview, "role">): string {
  return `頼みたい事をそのまま書いてください。${staff.role}が作業していなければタスクにして、タスクのタブに足します。作業中なら今の作業に渡します`;
}

/** オーナーの発言の本文の props */
export interface OwnerBodyProps {
  /** 話す社員 */
  staff: StaffOverview;
  /** 本文 */
  body: string;
  /** 社員に渡した道と、タスクにした時の足したタスク。null はまだ渡していない */
  delivery: Delivered | null;
  /** 発言から足した勤務の指示 */
  orders: readonly (MessageOrder | SkippedOrder)[];
}

/**
 * オーナーの発言の本文と、社員に渡ったかの印と、タスクにした時のタスクへの道と、発言から足した指示
 * @param props 社員、本文、渡した道、指示
 * @returns 本文と印
 */
export function OwnerBody({ staff, body, delivery, orders }: OwnerBodyProps) {
  const via = delivery?.via ?? "pending";
  return (
    <>
      {body}
      <br />
      <Badge tone={DELIVERY_TONE[via]}>{DELIVERY_LABEL[via]}</Badge>
      {delivery?.via === "task" && delivery.taskId !== null ? (
        <>
          {" "}
          <Link href={taskHref(staff.id, delivery.taskId)}>タスクを開く</Link>
        </>
      ) : null}
      <MessageOrders staff={staff} orders={orders} />
    </>
  );
}
