// セキュリティの画面の効き目と蒸留した学び。止めた回数、誤って止めた割合、多い原因、入れた対策の前後 7 日を入口から読み、蒸留の案を承認するか差し戻す (サービスと拡張の 3.6)
import { GuardEffect, Lesson, type LessonKind, type LessonStatus } from "@know-office/core";
import { Alert, Button, Grid, Stack, Stat, Table } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { EMPTY_TEXT, signalLabel } from "./labels.ts";
import { type Failed, FailedAlert, failureOf, type Loaded, useLoad } from "../../parts/load.tsx";

/** 案の種類 */
type Kind = z.infer<typeof LessonKind>;
/** 案の状態 */
type Status = z.infer<typeof LessonStatus>;

const KIND_LABEL: Record<Kind, string> = { prompt_rule: "説明文の決まり", threshold: "基準の直し", rule_tool: "ルールかツールの直し" };
const STATUS_LABEL: Record<Status, string> = { proposed: "決めていない", approved: "承認した", rejected: "差し戻した", applied: "入れた" };

/**
 * 蒸留の案の一覧を読む
 * @returns 読んでいる、読めた、読めなかった
 */
function useLessons(): Loaded<Lesson[]> {
  return useLoad(z.array(Lesson), (api) => api.api.v1.guard.lessons.$get({ query: {} }));
}

/**
 * 自動停止の効き目。止めた回数、誤って止めた割合、多い原因、入れた対策の前後 7 日の止めた回数
 * @returns 効き目
 */
export function GuardEffectView() {
  const effect = useLoad(GuardEffect, (api) => api.api.v1.guard.effect.$get({ query: {} }));
  const lessons = useLessons();
  if (effect.state === "loading") return <p role="status">効き目を読んでいます</p>;
  if (effect.state === "failed") return <FailedAlert title="効き目を読めませんでした" failure={effect} />;
  const proposals = new Map((lessons.state === "ok" ? lessons.data : []).map((l) => [l.id, l.proposal]));
  const { stops, falseRatio, topCauses, measures } = effect.data;
  return (
    <Stack gap={3}>
      <Grid minItemWidth={200}>
        <Stat label="止めた回数" icon="flag" value={stops} unit="回" />
        <Stat label="誤って止めた割合" icon="chart-bar" value={Math.round(falseRatio * 100)} unit="%" sub="判定のある停止のうち" />
      </Grid>
      <Table
        label="多い原因"
        rowKey={(r) => r.signal}
        rows={topCauses}
        emptyText={EMPTY_TEXT.causes}
        columns={[
          { key: "signal", header: "原因", render: (r) => signalLabel(r.signal) },
          { key: "count", header: "止めた回数", numeric: true, render: (r) => `${String(r.count)} 回` },
        ]}
      />
      <Table
        label="入れた対策の効き目"
        rowKey={(r) => r.lessonId}
        rows={measures}
        emptyText={EMPTY_TEXT.measures}
        columns={[
          { key: "lessonId", header: "対策", wrap: true, render: (r) => proposals.get(r.lessonId) ?? r.lessonId },
          { key: "before", header: "入れる前の 7 日", numeric: true, render: (r) => `${String(r.before)} 回` },
          { key: "after", header: "入れた後の 7 日", numeric: true, render: (r) => `${String(r.after)} 回` },
        ]}
      />
    </Stack>
  );
}

/**
 * 蒸留した学び。決めていない案は承認するか差し戻せる。基準の案は承認の後、基準の画面でパスキーを確かめて入れる
 * @returns 案の一覧
 */
export function LessonList() {
  const api = useContext(ApiContext);
  const loaded = useLessons();
  const [decided, setDecided] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();
  if (loaded.state === "loading") return <p role="status">蒸留した学びを読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="蒸留した学びを読めませんでした" failure={loaded} />;

  const decide = async (lesson: Lesson, decision: "approve" | "reject") => {
    if (!api) return;
    setBusy(lesson.id);
    setDone(undefined);
    setFailure(undefined);
    const reason = decision === "approve" ? "オーナーが画面で承認した" : "オーナーが画面で差し戻した";
    const res = await api.api.v1.guard.lessons[":lessonId"].decision
      .$post({ param: { lessonId: lesson.id }, json: { decision, reason } })
      .catch(() => null);
    setBusy(null);
    if (!res) {
      setFailure({ code: "network", traceId: null });
      return;
    }
    if (!res.ok) {
      setFailure(await failureOf(res));
      return;
    }
    const next = (await res.json()).data;
    setDecided((d) => ({ ...d, [lesson.id]: next.status }));
    setDone(decision === "approve" ? "承認して入れました" : "案を差し戻しました");
  };

  const rows = loaded.data.map((l) => ({ ...l, status: decided[l.id] ?? l.status }));
  return (
    <Stack gap={3}>
      <Table
        label="蒸留した学び"
        rowKey={(r) => r.id}
        rows={rows}
        emptyText={EMPTY_TEXT.lessons}
        columns={[
          { key: "proposal", header: "案", wrap: true, render: (r) => `${KIND_LABEL[r.kind]}: ${r.proposal}` },
          { key: "cause", header: "原因", render: (r) => signalLabel(r.cause) },
          {
            key: "status",
            header: "今",
            render: (r) =>
              r.status === "proposed" ? (
                <Stack direction="row" gap={2}>
                  <Button aria-label={`${r.proposal}を承認する`} disabled={busy !== null} onClick={() => void decide(r, "approve")}>
                    承認する
                  </Button>
                  <Button aria-label={`${r.proposal}を差し戻す`} variant="secondary" disabled={busy !== null} onClick={() => void decide(r, "reject")}>
                    差し戻す
                  </Button>
                </Stack>
              ) : (
                STATUS_LABEL[r.status]
              ),
          },
        ]}
      />
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="案を決められませんでした" failure={failure} /> : null}
    </Stack>
  );
}
