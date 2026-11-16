// 社員との会話。入口から新しい順に読んで古い順に並べ、配信で届いた発言を足し、オーナーの言葉を送る (社員と自動の 3.7)
import { Message, type StaffOverview } from "@know-office/core";
import { Button, Conversation, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { jstTime } from "../../format.ts";
import { useLiveEvent, useLiveTick } from "../../parts/live.tsx";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";

/** 1 度に読む発言の数 */
const MESSAGE_PAGE = "50";

export interface TalkProps {
  /** 話す社員 */
  staff: StaffOverview;
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
    setArrived((before) => (before.some((m) => m.id === message.id) ? before : [...before, message]));
  });
  const [text, setText] = useState("");
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
    const sent = await send(api, () => api.api.v1.staff[":staffId"].messages.$post({ param: { staffId: staff.id }, json: { body: text } }));
    setBusy(false);
    if (!sent.ok) return setFailure(sent.failure);
    const made = z.object({ data: Message }).loose().parse(await sent.res.json()).data;
    setArrived((before) => [...before, made]);
    setText("");
  };
  return (
    <Stack gap={3}>
      <Conversation
        label={`${staff.role}との会話`}
        messages={shown.map((m) => ({ id: m.id, from: m.sender === "owner" ? "self" : "other", author: m.sender === "owner" ? "オーナー" : staff.role, time: m.at, timeLabel: jstTime(m.at), body: m.body }))}
        empty={<p>まだ話していない</p>}
      />
      <TextField
        label={`${staff.role}への言葉`}
        hint="送った言葉は記録に残ります。社員に渡す仕組みはまだ無く、社員はまだ読みません"
        value={text}
        onChange={(e) => setText(e.target.value)}
        multiline
      />
      <Stack direction="row" gap={2}>
        <Button loading={busy} disabled={busy || text.trim() === ""} onClick={() => void submit()}>
          送る
        </Button>
      </Stack>
      {failure ? <FailedAlert title="言葉を送れませんでした" failure={failure} /> : null}
    </Stack>
  );
}
