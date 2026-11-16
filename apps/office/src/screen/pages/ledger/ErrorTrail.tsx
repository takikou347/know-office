// 記録の画面のエラーログと、traceId で 1 つの要求をたどる所。一覧は /errors から読み、たどる時はパスキーで確かめてから /traces/{traceId} を読む (ログインと記録の 3.6)
import { ErrorEvent, Trace } from "@know-office/core";
import { Button, Link, Stack, Table } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";

/** エラーログの一覧に出す件数 */
const ERRORS_SHOWN = 20;

/** traceId の形。クエリから来た物はこれに合う時だけ使う */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** 種類ごとの出す名前 */
const KIND_LABEL: Record<Trace["items"][number]["kind"], string> = {
  error: "エラー",
  audit: "監査ログ",
  tool_call: "ツール",
  usage: "使用量",
  node_event: "タスク",
  message: "会話",
};

/**
 * 1 つの要求をたどる道を作る
 * @param traceId traceId
 * @returns 記録の画面の道
 */
export function tracePath(traceId: string): string {
  return `/records?trace=${traceId}`;
}

/**
 * 新しいエラーログの一覧。traceId のある行から、その要求をたどる所へ移る
 * @returns 表
 */
export function ErrorLog() {
  const loaded = useLoad(z.array(ErrorEvent), (a) => a.api.v1.errors.$get({ query: { limit: String(ERRORS_SHOWN) } }));
  if (loaded.state === "failed") return <FailedAlert title="エラーログを読めませんでした" failure={loaded} />;
  return (
    <Table
      label="新しいエラーログ"
      loading={loaded.state === "loading"}
      rowKey={(r) => r.id}
      rows={loaded.state === "ok" ? loaded.data : []}
      columns={[
        { key: "at", header: "時刻", numeric: true, render: (r) => jstDateTime(r.at) },
        { key: "source", header: "書いた所" },
        { key: "code", header: "code" },
        { key: "message", header: "中身" },
        {
          key: "traceId",
          header: "要求",
          render: (r) => (r.traceId === null ? "なし" : <Link href={tracePath(r.traceId)}>{`${r.code} の要求をたどる`}</Link>),
        },
      ]}
      emptyText="エラーログは無い"
    />
  );
}

export interface TraceViewProps {
  /** たどる要求の traceId。クエリから来たまま渡し、形はここで確かめる */
  traceId: string;
}

/**
 * 1 つの要求の記録を時刻の順に出す。監査ログと会話を含むので、押した時にパスキーで確かめてから読む
 * @returns たどった記録
 */
export function TraceView({ traceId }: TraceViewProps) {
  const api = useContext(ApiContext);
  const [state, setState] = useState<{ step: "idle" | "loading" } | { step: "ok"; trace: Trace } | { step: "failed"; failure: Failed }>({ step: "idle" });
  if (!TRACE_ID.test(traceId)) return <p>問い合わせの番号の形が違います。</p>;
  const open = async () => {
    if (!api) return;
    setState({ step: "loading" });
    const sent = await send(api, () => api.api.v1.traces[":traceId"].$get({ param: { traceId } }));
    if (!sent.ok) {
      setState({ step: "failed", failure: sent.failure });
      return;
    }
    setState({ step: "ok", trace: z.object({ data: Trace }).loose().parse(await sent.res.json()).data });
  };
  return (
    <Stack gap={2}>
      <p>{`問い合わせの番号 ${traceId} の要求`}</p>
      {state.step === "ok" ? null : (
        <Button disabled={state.step === "loading"} onClick={() => void open()}>
          パスキーで確かめて記録を開く
        </Button>
      )}
      {state.step === "failed" ? <FailedAlert title="要求の記録を読めませんでした" failure={state.failure} /> : null}
      {state.step === "ok" ? (
        <Table
          label="要求の記録"
          rowKey={(r) => `${r.kind}.${r.id}`}
          rows={state.trace.items}
          columns={[
            { key: "at", header: "時刻", numeric: true, render: (r) => jstDateTime(r.at) },
            { key: "kind", header: "種類", render: (r) => KIND_LABEL[r.kind] },
            { key: "summary", header: "中身" },
          ]}
          emptyText="記録は無い"
        />
      ) : null}
    </Stack>
  );
}
