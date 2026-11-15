// セキュリティの画面の効き目と蒸留した学び。止めた回数、誤って止めた割合、多い原因、入れた対策の前後 7 日を入口から読み、蒸留の案を承認するか差し戻す (サービスと拡張の 3.6)
import { GuardEffect, GuardSignal, Lesson, type LessonKind, type LessonStatus } from "@know-office/core";
import { Alert, Button, Grid, Stack, Stat, Table } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../../api.ts";

/** 案の種類 */
type Kind = z.infer<typeof LessonKind>;
/** 案の状態 */
type Status = z.infer<typeof LessonStatus>;

const Failure = z.object({ code: z.string(), traceId: z.string() }).loose();

/** 読めなかった時と決められなかった時の理由。不具合を伝えられるよう traceId を添える */
type Failed = { code: string; traceId: string | null };

type Loaded<T> = { state: "loading" } | { state: "ok"; data: T } | ({ state: "failed" } & Failed);

/** シグナルの名前 */
const SIGNAL_LABEL: Record<GuardSignal, string> = {
  rule_denied: "ルールの外の操作",
  repeated_failure: "同じ失敗の繰り返し",
  unchecked_merge: "チェックを通らないマージ",
  task_overrun: "1 つのタスクの最長時間",
  staff_rule_denied: "社員のルールの外の操作",
  token_rate: "トークンの速さ",
  tool_rate: "操作の速さ",
  exfiltration: "外部の文章の後の持ち出し",
  deploy_failure: "デプロイの後の失敗",
  library_build: "ライブラリの組むチェック",
  certain_fraud: "確かな不正",
  stacked_suspicion: "重なった怪しい動き",
  manual: "手で止めた",
};

const KIND_LABEL: Record<Kind, string> = { prompt_rule: "説明文の決まり", threshold: "基準の直し", rule_tool: "ルールかツールの直し" };
const STATUS_LABEL: Record<Status, string> = { proposed: "決めていない", approved: "承認した", rejected: "差し戻した", applied: "入れた" };

/**
 * シグナルの名前を返す。知らない名前はそのまま出す
 * @param signal シグナル
 * @returns 名前
 */
function signalLabel(signal: string): string {
  const known = GuardSignal.safeParse(signal);
  return known.success ? SIGNAL_LABEL[known.data] : signal;
}

/** 入口の返事のうち、読むのに使う所 */
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * 失敗の返事から code と traceId を読む
 * @param res 返事
 * @returns code と traceId
 */
async function failureOf(res: Reply): Promise<Failed> {
  const body = Failure.safeParse(await res.json().catch(() => null));
  return body.success ? { code: body.data.code, traceId: body.data.traceId } : { code: String(res.status), traceId: null };
}

/**
 * 入口から 1 度読み、返った data を形で確かめる。入口を呼ぶ口が無ければ読めなかった事にする
 * @param schema data の形
 * @param read 入口を呼んで返事を返す
 * @returns 読んでいる、読めた、読めなかった
 */
function useLoad<T>(schema: z.ZodType<T>, read: (api: Api) => Promise<Reply>): Loaded<T> {
  const api = useContext(ApiContext);
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    // 入口を呼ぶ口が無い時は読みに行かない。返す形は下で読めなかった事にする
    void (api ? read(api) : Promise.reject(new Error("入口を呼ぶ口が無い")))
      .then(async (res): Promise<Loaded<T>> => {
        if (res.ok) return { state: "ok", data: z.object({ data: schema }).loose().parse(await res.json()).data };
        return { state: "failed", ...(await failureOf(res)) };
      })
      .catch((): Loaded<T> => ({ state: "failed", code: "network", traceId: null }))
      .then((value) => {
        if (live) setLoaded(value);
      });
    return () => {
      live = false;
    };
    // 読み方は描くたびに作り直すが、同じ入口からは 1 度だけ読む
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  if (!api) return { state: "failed", code: "network", traceId: null };
  return loaded;
}

/**
 * 読めなかった事を出す
 * @param props 題と理由
 * @param props.title 題
 * @param props.failure 理由
 * @returns 知らせ
 */
function FailedAlert({ title, failure }: { title: string; failure: Failed }) {
  return (
    <Alert tone="error" title={title} live>
      {failure.code === "network" ? "入口につながりません。" : `理由: ${failure.code}。`}
      {failure.traceId ? ` 問い合わせの番号: ${failure.traceId}` : null}
    </Alert>
  );
}

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
        emptyText="まだ止めていない"
        columns={[
          { key: "signal", header: "原因", render: (r) => signalLabel(r.signal) },
          { key: "count", header: "止めた回数", numeric: true, render: (r) => `${String(r.count)} 回` },
        ]}
      />
      <Table
        label="入れた対策の効き目"
        rowKey={(r) => r.lessonId}
        rows={measures}
        emptyText="まだ対策を入れていない"
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
    setDone(decision === "approve" ? "案を承認しました" : "案を差し戻しました");
  };

  const rows = loaded.data.map((l) => ({ ...l, status: decided[l.id] ?? l.status }));
  return (
    <Stack gap={3}>
      <Table
        label="蒸留した学び"
        rowKey={(r) => r.id}
        rows={rows}
        emptyText="まだ学びは無い"
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
