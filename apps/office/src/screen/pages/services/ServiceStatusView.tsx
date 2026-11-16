// サービスの様子を種類ごとに出す。ライブラリは公開とそろいと使う側の版、Web アプリは版と利用者数と失敗率と費用と手で戻すボタン、コンテンツは公開した物と読まれた数 (サービスと拡張の 3.2)
import type { ServiceDetail, ServiceStatus } from "@know-office/core";
import { Alert, Button, Dialog, DialogClose, List, Stack, Stat, Status, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, send } from "../../parts/load.tsx";
import { dollars } from "./labels.ts";

/** 戻せる段階。作った後だけ */
const LIVE_STAGES: readonly string[] = ["prototype", "service", "operation"];

interface RollbackProps {
  /** 戻すサービス */
  service: ServiceDetail;
  /** 戻した後に呼ぶ。様子と記録を読み直すのに使う */
  onDone: () => void;
}

/** 前のバージョンに戻すボタン。理由を書いて確かめ、パスキーで確かめてから送る */
function RollbackButton({ service, onDone }: RollbackProps) {
  const api = useContext(ApiContext);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<Failed>();

  const rollback = async () => {
    if (!api) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.services[":serviceId"].rollback.$post({ param: { serviceId: service.id }, json: { reason: reason.trim() } }), { required: true });
    setBusy(false);
    setOpen(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setReason("");
    setDone(true);
    onDone();
  };

  return (
    <Stack gap={2}>
      <Stack direction="row" gap={2}>
        <Button
          variant="danger"
          onClick={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          前のバージョンに戻す
        </Button>
      </Stack>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`${service.name} を前のバージョンに戻しますか`}
        description="GitHub の rollback.yml を動かします。戻した後 10 分は重ねて戻せません。"
        actions={
          <>
            <DialogClose variant="secondary">取り消す</DialogClose>
            <Button variant="danger" loading={busy} disabled={reason.trim() === ""} onClick={() => void rollback()}>
              戻す
            </Button>
          </>
        }
      >
        <TextField label="戻す理由" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      </Dialog>
      {done ? (
        <Alert tone="success" live>
          戻すよう GitHub に頼みました
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="戻せませんでした" failure={failure} /> : null}
    </Stack>
  );
}

/**
 * 時刻があれば日本時間の文にする
 * @param iso RFC 3339 の時刻
 * @returns 文。無ければ「まだ無い」
 */
const when = (iso: string | null) => (iso === null ? "まだ無い" : jstDateTime(iso));

/**
 * npm への公開の結果の文
 * @param publish 最新の公開の結果
 * @returns 文
 */
function publishText(publish: { passed: boolean } | null): string {
  if (publish === null) return "まだ無い";
  return publish.passed ? "できた" : "失敗した";
}

/** ライブラリの様子 */
function LibraryView({ status, name }: { status: Extract<ServiceStatus, { kind: "library" }>; name: string }) {
  return (
    <Stack gap={3}>
      <Stack direction="row" gap={3} wrap>
        <Stat label="公開した版" value={status.version ?? "まだ無い"} sub={`公開 ${when(status.releasedAt)}`} />
        <Stat label="npm への公開" value={publishText(status.publish)} sub={status.publish ? jstDateTime(status.publish.at) : undefined} />
      </Stack>
      {status.aligned ? null : (
        <Alert tone="warn" title="版がそろっていません">
          パッケージと説明のサイトの版をそろえてください
        </Alert>
      )}
      <List label={`${name} のパッケージ`} items={status.packages.map((p) => ({ id: p.name, title: p.name, meta: p.version }))} emptyText="まだ公開を読んでいない" />
      <List
        label={`${name} を使っているサービス`}
        items={status.usedBy.map((u) => ({
          id: u.serviceId,
          title: u.name,
          href: `/services/${u.serviceId}`,
          meta: u.version,
          side: <Status kind={u.behind ? "warn" : "success"} label={u.behind ? "古い版" : "最新"} />,
        }))}
        emptyText="使っているサービスはまだ無い"
      />
    </Stack>
  );
}

export interface ServiceStatusViewProps {
  /** サービスの詳細 */
  service: ServiceDetail;
  /** 戻した後に呼ぶ */
  onChanged: () => void;
}

/** 種類ごとのサービスの様子 */
export function ServiceStatusView({ service, onChanged }: ServiceStatusViewProps) {
  const status = service.status;
  if (status.kind === "library") return <LibraryView status={status} name={service.name} />;
  if (status.kind === "content") {
    return (
      <Stack gap={3}>
        <Stat label="直前 24 時間に読まれた数" value={status.reads ?? "まだ無い"} />
        <List label={`${service.name} で公開した物`} items={status.published.map((p, n) => ({ id: String(n), title: p.title, meta: jstDateTime(p.at) }))} emptyText="公開した物はまだ無い" />
      </Stack>
    );
  }
  return (
    <Stack gap={3}>
      <Stack direction="row" gap={3} wrap>
        <Stat label="版" value={status.version ?? "まだ無い"} sub={`デプロイ ${when(status.deployedAt)}`} />
        <Stat label="利用者数" value={status.users ?? "まだ無い"} />
        <Stat label="直前 24 時間の失敗率" value={status.errorRate === null ? "まだ無い" : `${(status.errorRate * 100).toFixed(1)}%`} />
        <Stat label="今月の費用" value={dollars(status.costMicroUsd)} />
      </Stack>
      {status.rolledBackAt ? <p>最後に戻した時刻: {jstDateTime(status.rolledBackAt)}</p> : null}
      {service.repo !== null && LIVE_STAGES.includes(service.stage) ? <RollbackButton service={service} onDone={onChanged} /> : null}
    </Stack>
  );
}
