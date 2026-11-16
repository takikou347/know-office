// 承認を決める画面。社員が求めた承認を古い順に読み、理由を付けて承認か差し戻しを送る。1 件だけの道 (/approvals/<ID>) も同じ形で出す (タスクとレビューの 3.1)
import { Approval } from "@know-office/core";
import { Alert, Button, Card, Dialog, DialogClose, Stack, TextField } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, failureOf, send } from "../../parts/load.tsx";
import { Part, Section } from "../../parts/section.tsx";
import { stillPending } from "./pending.ts";
import { approvalDetails, approvalTitle, decideHref, KIND_NOTE, KIND_PLACE, PLACE_LINK, requesterName, STEP_UP_KINDS } from "./kinds.ts";

/** 1 度に読む件数 */
const PAGE = 20;

const Page = z.object({ data: z.array(Approval), meta: z.object({ next: z.string().nullable().optional() }).loose() });

/** 承認か差し戻し */
type Decision = "approve" | "reject";

const DECISION_LABEL: Record<Decision, string> = { approve: "承認する", reject: "差し戻す" };
const DONE_LABEL: Record<Decision, string> = { approve: "承認しました", reject: "差し戻しました" };

/** 読んだ承認の並び。続きがあれば next のカーソルを持つ */
type Listed = { state: "loading" } | ({ state: "failed" } & Failed) | { state: "ok"; items: Approval[]; next: string | null };

/**
 * 決めていない承認を、カーソルの続きから 1 ページ読む
 * @param tick 読み直す時に変える数
 * @returns 読んだ並びと、続きを読む関数
 */
function usePending(tick: number): { listed: Listed; more: () => Promise<void> } {
  const api = useContext(ApiContext);
  const [listed, setListed] = useState<Listed>({ state: "loading" });
  const read = async (cursor: string | null): Promise<Listed> => {
    if (!api) return { state: "failed", code: "network", traceId: null };
    const res = await api.api.v1.approvals.$get({ query: { status: "pending", limit: String(PAGE), ...(cursor ? { cursor } : {}) } }).catch(() => null);
    if (!res) return { state: "failed", code: "network", traceId: null };
    if (!res.ok) return { state: "failed", ...(await failureOf(res)) };
    const page = Page.safeParse(await res.json());
    return page.success ? { state: "ok", items: page.data.data, next: page.data.meta.next ?? null } : { state: "failed", code: "malformed", traceId: null };
  };
  useEffect(() => {
    let live = true;
    void read(null).then((next) => {
      if (live) setListed(next);
    });
    return () => {
      live = false;
    };
    // 読み直すのは tick が変わった時だけ
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tick]);
  const more = async () => {
    if (listed.state !== "ok" || listed.next === null) return;
    const next = await read(listed.next);
    setListed(next.state === "ok" ? { state: "ok", items: [...listed.items, ...next.items], next: next.next } : next);
  };
  return { listed, more };
}

export interface ApprovalsPageProps {
  /** URL のパス。/approvals か /approvals/<承認 ID> */
  pathname: string;
}

/** 承認を決める画面 */
export function ApprovalsPage({ pathname }: ApprovalsPageProps) {
  const [tick, setTick] = useState(0);
  const [done, setDone] = useState<{ tone: "success" | "warn"; text: string }>();
  const { listed, more } = usePending(tick);
  const [, , id = ""] = pathname.split("/");
  const one = z.uuid().safeParse(id);

  const decided = (text: string) => {
    setDone({ tone: "success", text });
    setTick((t) => t + 1);
  };
  // 先に決まった承認は並びから消えるので、ダイアログでなく画面の上に知らせる
  const stale = (title: string) => {
    setDone({ tone: "warn", text: `「${title}」はほかの所で先に決まっていました` });
    setTick((t) => t + 1);
  };

  const body = () => {
    if (listed.state === "loading") return <p role="status">読んでいます</p>;
    if (listed.state === "failed") return <FailedAlert title="承認を読めませんでした" failure={listed} />;
    const items = one.success ? listed.items.filter((a) => a.id === one.data) : listed.items;
    if (items.length === 0) return <p>{one.success ? "決めるのを待っている承認ではありません" : "承認を待つ物は無い"}</p>;
    return (
      <Stack gap={3}>
        <ul aria-label="承認を待つ物" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-3)" }}>
          {items.map((a) => (
            <li key={a.id}>
              <ApprovalCard approval={a} onDecided={decided} onStale={stale} />
            </li>
          ))}
        </ul>
        {!one.success && listed.next !== null ? (
          <Button variant="secondary" onClick={() => void more()}>
            もっと読む
          </Button>
        ) : null}
      </Stack>
    );
  };

  return (
    <Section>
      <Part title="承認を待つ物">
        {one.success ? <a href="/approvals">承認を待つ物の一覧へ</a> : null}
        {done ? (
          <Alert tone={done.tone} live>
            {done.text}
          </Alert>
        ) : null}
        {body()}
      </Part>
    </Section>
  );
}

interface ApprovalCardProps {
  /** 承認 */
  approval: Approval;
  /** 決めた後に呼ぶ。知らせる文を受ける */
  onDecided: (text: string) => void;
  /** ほかの所で先に決まっていた時に呼ぶ。承認の見出しを受け、並びを読み直す */
  onStale: (title: string) => void;
}

/** 承認 1 件。中身と、承認か差し戻しのボタン、ほかの画面で決める種類は決める所 */
function ApprovalCard({ approval, onDecided, onStale }: ApprovalCardProps) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const title = approvalTitle(approval);
  const place = KIND_PLACE[approval.kind];
  const href = decideHref(approval);
  return (
    <Card
      title={title}
      headingLevel={3}
      subtitle={`${requesterName(approval.requestedBy)}が ${jstDateTime(approval.requestedAt)} に求めた`}
      actions={
        place === "here" ? (
          <>
            <Button variant="secondary" onClick={() => setDecision("reject")}>
              差し戻す
            </Button>
            <Button onClick={() => setDecision("approve")}>承認する</Button>
          </>
        ) : null
      }
    >
      <Stack gap={2}>
        {approvalDetails(approval).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>{KIND_NOTE[approval.kind]}</p>
        {place === "review" || place === "guard" ? <PlaceLink href={href} text={PLACE_LINK[place]} /> : null}
      </Stack>
      {decision ? (
        <DecideDialog
          approval={approval}
          title={title}
          decision={decision}
          onClose={() => setDecision(null)}
          onDecided={(text) => {
            setDecision(null);
            onDecided(text);
          }}
          onStale={() => {
            setDecision(null);
            onStale(title);
          }}
        />
      ) : null}
    </Card>
  );
}

interface PlaceLinkProps {
  /** 決める所への道。組めなかった時は null */
  href: string | null;
  /** 道の文 */
  text: string;
}

/** ほかの画面で決める種類の、決める所への道 */
function PlaceLink({ href, text }: PlaceLinkProps) {
  if (href === null) return <p>決める所を読めませんでした</p>;
  return <a href={href}>{text}</a>;
}

interface DecideDialogProps {
  /** 承認 */
  approval: Approval;
  /** 承認の見出し */
  title: string;
  /** 承認か差し戻し */
  decision: Decision;
  /** 閉じた時に呼ぶ */
  onClose: () => void;
  /** 決めた後に呼ぶ */
  onDecided: (text: string) => void;
  /** ほかの所で先に決まっていた時に呼ぶ。ダイアログを閉じる */
  onStale: () => void;
}

/** 理由を入れて、承認か差し戻しを送るダイアログ。送れなければ開いたまま理由を出す */
function DecideDialog({ approval, title, decision, onClose, onDecided, onStale }: DecideDialogProps) {
  const api = useContext(ApiContext);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const label = DECISION_LABEL[decision];
  const needsPasskey = decision === "approve" && STEP_UP_KINDS.has(approval.kind);

  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.approvals[":approvalId"].decision.$post({ param: { approvalId: approval.id }, json: { decision, reason: reason.trim() } }), { required: needsPasskey });
    if (!sent.ok) {
      // 409 は先に決まった時のほか、この画面で決めない種類や対象が変わった時にも返る。並びから消えた時だけ先に決まったと出す
      const stale = sent.failure.code === "conflict" && !(await stillPending(api, approval.id));
      setBusy(false);
      if (stale) onStale();
      else setFailure(sent.failure);
      return;
    }
    setBusy(false);
    onDecided(`「${title}」を${DONE_LABEL[decision]}`);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={decision === "approve" ? "承認しますか" : "差し戻しますか"}
      description={title}
      actions={
        <>
          <DialogClose variant="secondary" disabled={busy}>
            やめる
          </DialogClose>
          <Button loading={busy} disabled={busy || reason.trim() === ""} onClick={() => void submit()}>
            {label}
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        {needsPasskey ? <p>送る前にパスキーで確かめます。</p> : null}
        <TextField label="理由" required value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
        {failure ? <FailedAlert title={`${label}事ができませんでした`} failure={failure} /> : null}
        {failure?.detail ? <p>{failure.detail}</p> : null}
      </Stack>
    </Dialog>
  );
}
