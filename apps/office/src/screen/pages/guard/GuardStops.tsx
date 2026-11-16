// セキュリティの画面の、止めている物と止めた記録。止めている物を再開し、直前 20 件の記録の中身を開いて判定を付ける (自動停止の 3.6)
import { GuardState, type GuardScope, Resumption, StopDetail, StopRow, StopVerdict } from "@know-office/core";
import { Alert, Button, Card, Dialog, DialogClose, RadioGroup, Stack, Status, Table, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { SCOPE_LABEL, signalLabel, targetLabel, VERDICT_LABEL } from "./labels.ts";

/** 止めた記録を出す件数。直前の 20 件 */
const HISTORY_LIMIT = 20;

/** 判定の値 */
type Verdict = z.infer<typeof StopVerdict>;

const VERDICTS: readonly Verdict[] = StopVerdict.options;
const ServiceNames = z.array(z.object({ id: z.string(), name: z.string() }).loose());

/**
 * サービス ID から名前への対応を読む。読めない間は空で、相手は ID のまま出す
 * @returns サービス ID から名前への対応
 */
function useServiceNames(): ReadonlyMap<string, string> {
  const loaded = useLoad(ServiceNames, (api) => api.api.v1.services.$get({ query: { limit: "100" } }));
  return new Map(loaded.state === "ok" ? loaded.data.map((s) => [s.id, s.name]) : []);
}

/**
 * 記録の 1 行の今を文にする
 * @param row 記録の 1 行
 * @returns 近かった、止めている、再開した時刻
 */
function nowText(row: StopRow): string {
  if (row.kind === "near") return "近かった";
  return row.resumedAt === null ? "止めている" : `${jstDateTime(row.resumedAt)} に再開した`;
}

/**
 * 止めた理由を文にする。手で止めた時は数えた値が無い
 * @param row 記録の 1 行
 * @returns シグナルの名前と、数えた値とその時の基準
 */
function reasonText(row: StopRow): string {
  if (row.signal === "manual") return signalLabel(row.signal);
  return `${signalLabel(row.signal)} (数えた値 ${String(row.measured)}、基準 ${String(row.threshold)})`;
}

export interface GuardStopsProps {
  /** 読み直す時に変える数 */
  tick: number;
  /** 再開した、判定を付けた時に呼ぶ */
  onChanged: () => void;
}

/** 止めている物。1 件ずつ再開できる。サービスと全体はパスキーで確かめる */
export function StoppedList({ tick, onChanged }: GuardStopsProps) {
  const api = useContext(ApiContext);
  const state = useLoad(GuardState, (a) => a.api.v1.guard.state.$get(), tick);
  const rows = useLoad(z.array(StopRow), (a) => a.api.v1.guard.stops.$get({ query: { kind: "stop", limit: String(HISTORY_LIMIT) } }), tick);
  const services = useServiceNames();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();
  if (state.state === "loading") return <p role="status">止めている物を読んでいます</p>;
  if (state.state === "failed") return <FailedAlert title="止めている物を読めませんでした" failure={state} />;

  const resume = async (stopId: string, name: string, scope: string) => {
    if (!api) return;
    setBusy(stopId);
    setDone(undefined);
    setFailure(undefined);
    // サービスと全体の再開は必ずパスキーで確かめるので、切れていれば先に確かめる
    const sent = await send(api, () => api.api.v1.guard.stops[":stopId"].resume.$post({ param: { stopId } }), { required: scope === "service" || scope === "office" });
    setBusy(null);
    if (sent.ok) {
      const { resumedAt } = z.object({ data: Resumption }).loose().parse(await sent.res.json()).data;
      setDone(`${name}を ${jstDateTime(resumedAt)} に再開しました`);
    } else {
      setFailure(sent.failure);
    }
    onChanged();
  };

  const signals = new Map((rows.state === "ok" ? rows.data : []).map((r) => [r.id, reasonText(r)]));
  return (
    <Stack gap={3}>
      {state.data.stopped.length === 0 ? <p>止めている物は無い</p> : null}
      {state.data.stopped.map((s) => {
        const name = targetLabel(s.scope, s.target, services);
        return (
          <Card
            key={s.stopId}
            title={name}
            headingLevel={3}
            subtitle={`${jstDateTime(s.since)} から`}
            badge={<Status kind="stopped" label="止めている" />}
            actions={
              <Button aria-label={`${name}を再開する`} loading={busy === s.stopId} disabled={busy !== null && busy !== s.stopId} onClick={() => void resume(s.stopId, name, s.scope)}>
                再開する
              </Button>
            }
          >
            {SCOPE_LABEL[s.scope]}を止めている。{signals.get(s.stopId) ?? ""}
          </Card>
        );
      })}
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="再開できませんでした" failure={failure} /> : null}
      {failure?.code === "conflict" ? <p>全体を再開する前に、設定の画面で GitHub App と Claude の鍵を入れ直してください</p> : null}
    </Stack>
  );
}

/** 止めた記録と近かった記録の直前の 20 件。行を開くと中身が出る */
export function StopHistory({ tick, onChanged }: GuardStopsProps) {
  const rows = useLoad(z.array(StopRow), (a) => a.api.v1.guard.stops.$get({ query: { limit: String(HISTORY_LIMIT) } }), tick);
  const services = useServiceNames();
  const [open, setOpen] = useState<string | null>(null);
  if (rows.state === "loading") return <p role="status">止めた記録を読んでいます</p>;
  if (rows.state === "failed") return <FailedAlert title="止めた記録を読めませんでした" failure={rows} />;
  const shown = rows.data.map((r) => ({ ...r, name: targetLabel(r.scope, r.target, services) }));
  return (
    <>
      <Table
        label="止めた記録"
        rowKey={(r) => r.id}
        rows={shown}
        emptyText="まだ止めていない"
        columns={[
          { key: "at", header: "時刻", numeric: true, render: (r) => jstDateTime(r.at) },
          { key: "name", header: "相手" },
          { key: "signal", header: "理由", wrap: true, render: (r) => reasonText(r) },
          { key: "resumedAt", header: "今", render: (r) => nowText(r) },
          { key: "verdict", header: "判定", render: (r) => (r.verdict === null ? "まだ" : VERDICT_LABEL[r.verdict]) },
          {
            key: "id",
            header: "中身",
            render: (r) => (
              <Button variant="secondary" aria-label={`${jstDateTime(r.at)} の${r.name}の記録を開く`} onClick={() => setOpen(r.id)}>
                開く
              </Button>
            ),
          },
        ]}
      />
      {open === null ? null : <StopRecord key={open} stopId={open} services={services} onClose={() => setOpen(null)} onJudged={onChanged} />}
    </>
  );
}

interface StopRecordProps {
  /** 開く記録の ID */
  stopId: string;
  /** サービス ID から名前への対応 */
  services: ReadonlyMap<string, string>;
  /** 閉じた時に呼ぶ */
  onClose: () => void;
  /** 判定を付けた時に呼ぶ */
  onJudged: () => void;
}

const Update = z.object({ id: z.string(), at: z.string(), kind: z.string(), by: z.string(), verdict: z.string().nullable(), reason: z.string().nullable() }).loose();

/**
 * 経緯の 1 行を文にする。形の違う行は中身をそのまま出す
 * @param entry 経緯の 1 行
 * @returns 時刻、した事、した者、理由
 */
function updateText(entry: Record<string, unknown>): string {
  const u = Update.safeParse(entry);
  if (!u.success) return JSON.stringify(entry);
  const verdict = StopVerdict.safeParse(u.data.verdict);
  const what = u.data.kind === "resumed" ? "再開した" : `判定: ${verdict.success ? VERDICT_LABEL[verdict.data] : (u.data.verdict ?? "")}`;
  const who = u.data.by === "owner" ? "オーナー" : (u.data.by === "reviewer" ? "レビュー担当" : u.data.by);
  return `${jstDateTime(u.data.at)} ${who}: ${what}${u.data.reason ? ` (${u.data.reason})` : ""}`;
}

/** 止めた記録 1 件の中身と、判定を付ける欄 */
function StopRecord({ stopId, services, onClose, onJudged }: StopRecordProps) {
  const api = useContext(ApiContext);
  const [tick, setTick] = useState(0);
  const detail = useLoad(StopDetail, (a) => a.api.v1.guard.stops[":stopId"].$get({ param: { stopId } }), tick);
  const [verdict, setVerdict] = useState<Verdict>("correct");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();

  const judge = async () => {
    if (!api) return;
    setBusy(true);
    setDone(undefined);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.guard.stops[":stopId"].verdict.$post({ param: { stopId }, json: { verdict, reason } }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setDone(`判定を「${VERDICT_LABEL[verdict]}」にしました`);
    setReason("");
    setTick((t) => t + 1);
    onJudged();
  };

  const d = detail.state === "ok" ? detail.data : null;
  const scope: GuardScope | null = d?.scope ?? null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="止めた記録"
      description={d && scope ? `${jstDateTime(d.at)} ${targetLabel(scope, d.target, services)}` : undefined}
      loading={detail.state === "loading"}
      actions={
        <>
          <DialogClose variant="secondary">閉じる</DialogClose>
          <Button loading={busy} disabled={d === null} onClick={() => void judge()}>
            判定を付ける
          </Button>
        </>
      }
    >
      {detail.state === "failed" ? <FailedAlert title="記録を読めませんでした" failure={detail} /> : null}
      {d ? (
        <Stack gap={3}>
          <dl>
            <dt>範囲</dt>
            <dd>{SCOPE_LABEL[d.scope]}</dd>
            <dt>当たったシグナル</dt>
            <dd>{signalLabel(d.signal)}</dd>
            <dt>数えた値とその時の基準</dt>
            <dd>
              数えた値 {d.measured}、基準 {d.threshold}、基準のバージョン {d.rulesVersion}
            </dd>
            <dt>使っていたモデル</dt>
            <dd>{d.model ?? "無し"}</dd>
            <dt>読んでいた外部の文章の出所</dt>
            <dd>{d.externalSources.length === 0 ? "無し" : d.externalSources.join("、")}</dd>
            <dt>今</dt>
            <dd>{nowText(d)}</dd>
            <dt>判定</dt>
            <dd>{d.verdict === null ? "まだ" : VERDICT_LABEL[d.verdict]}</dd>
          </dl>
          <section aria-label="直前の操作">
            <h3>直前の操作 ({d.recentOps.length} 件)</h3>
            {d.recentOps.length === 0 ? (
              <p>直前の操作は無い</p>
            ) : (
              <ol>
                {d.recentOps.map((op, i) => (
                  // 直前の操作は並びの順が中身で、足しも消しもしない
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={i}>
                    <code>{JSON.stringify(op)}</code>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="経緯">
            <h3>経緯</h3>
            {d.updates.length === 0 ? (
              <p>再開も判定もまだ無い</p>
            ) : (
              <ul>
                {d.updates.map((u, i) => (
                  // 経緯は足すだけの記録で、並びの順が中身
                  // oxlint-disable-next-line react/no-array-index-key
                  <li key={i}>{updateText(u)}</li>
                ))}
              </ul>
            )}
          </section>
          <RadioGroup
            legend="判定"
            options={VERDICTS.map((v) => ({ value: v, label: VERDICT_LABEL[v] }))}
            value={verdict}
            onValueChange={(v) => {
              const next = StopVerdict.safeParse(v);
              if (next.success) setVerdict(next.data);
            }}
          />
          <TextField label="判定の理由" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          {done ? (
            <Alert tone="success" live>
              {done}
            </Alert>
          ) : null}
          {failure ? <FailedAlert title="判定を付けられませんでした" failure={failure} /> : null}
        </Stack>
      ) : null}
    </Dialog>
  );
}
