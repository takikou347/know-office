// サービスの段階を移す欄。移れる先と理由を選んで送る。選び肢に無い理由だけを書く。作ると決める時は担当の社員と、GitHub の触れるリポジトリを選ぶ (サービスと拡張の 3.1)
import { optionsOf } from "@know-office/core/master/master";
import { SERVICE_MOVE_REASONS } from "@know-office/core/master/service-move-reasons";
import { AdvanceInput, NEXT_STAGES, Repo, type ServiceCard, ServiceStage, StaffId } from "@know-office/core";
import { Alert, Button, Field, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { useStaffOptions } from "../../parts/staff-list.ts";
import { MOVE_LABEL, OTHER_REASON } from "./labels.ts";

interface RepoPickerProps {
  /** 選んでいるリポジトリ */
  value: string | null;
  /** 選び直した時に呼ぶ */
  onChange: (repo: string) => void;
  /** 作ると決めるサービスの ID。あれば、入口がそのサービスに選べない物 (同じ名前のリポジトリを持つ別のサービスがある物と、設計書のリポジトリ) を除く */
  serviceId?: string;
}

/** GitHub の触れるリポジトリから 1 つ選ぶ。つないでいなければ、つなぐよう伝える */
export function RepoPicker({ value, onChange, serviceId }: RepoPickerProps) {
  const repos = useLoad(z.array(Repo), (a) => a.api.v1.github.repos.$get({ query: { limit: "100", ...(serviceId === undefined ? {} : { serviceId }) } }));
  if (repos.state === "failed") {
    return (
      <Alert tone="warn" title="リポジトリを選べません">
        設定の画面で GitHub とつなぐと選べます
      </Alert>
    );
  }
  return (
    <Field label="リポジトリ">
      <Select
        aria-label="リポジトリ"
        loading={repos.state === "loading"}
        value={value}
        placeholder="選ぶ"
        options={repos.state === "ok" ? repos.data.map((r) => ({ value: r.fullName, label: r.fullName })) : []}
        onValueChange={(v) => {
          if (v !== null) onChange(v);
        }}
      />
    </Field>
  );
}

export interface StageActionsProps {
  /** 移すサービス */
  service: ServiceCard;
  /** 移した後に呼ぶ */
  onMoved: () => void;
}

/** 段階を移す欄。移れる先が無ければ出さない */
export function StageActions({ service, onMoved }: StageActionsProps) {
  const api = useContext(ApiContext);
  const next = NEXT_STAGES[service.stage];
  const [to, setTo] = useState<ServiceStage | null>(next[0] ?? null);
  const [choice, setChoice] = useState<string | null>(null);
  const [written, setWritten] = useState("");
  const people = useStaffOptions();
  const [chosenStaff, setStaffId] = useState<StaffId | null>(null);
  // 選ぶまでは最初の開発担当を選んでおく
  const staffId = chosenStaff ?? people.find((p) => p.value.startsWith("builder"))?.value ?? "builder";
  const [repo, setRepo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  if (next.length === 0) return null;

  const prototype = to === "prototype";
  const reasons: string[] = to === null ? [] : SERVICE_MOVE_REASONS[to].map((r) => r.value);
  // 移す先を変えると、前の先の理由は合わないので選び直す
  const picked = choice !== null && (choice === OTHER_REASON || reasons.includes(choice)) ? choice : (reasons[0] ?? OTHER_REASON);
  const reason = picked === OTHER_REASON ? written : picked;
  const input = AdvanceInput.safeParse({ to, reason: reason.trim(), ...(prototype ? { staffId, repo: repo ?? undefined } : {}) });

  const move = async () => {
    if (!api || !input.success) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.services[":serviceId"].advance.$post({ param: { serviceId: service.id }, json: input.data }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setChoice(null);
    setWritten("");
    onMoved();
  };

  return (
    <Stack gap={3}>
      <Field label="移す先">
        <Select
          aria-label="移す先"
          value={to}
          options={next.map((s) => ({ value: s, label: MOVE_LABEL[s] }))}
          onValueChange={(v) => {
            const stage = ServiceStage.safeParse(v);
            if (stage.success) setTo(stage.data);
          }}
        />
      </Field>
      {prototype ? (
        <>
          <Field label="担当の社員">
            <Select
              aria-label="担当の社員"
              value={staffId}
              options={people}
              onValueChange={(v) => {
                const staff = StaffId.safeParse(v);
                if (staff.success) setStaffId(staff.data);
              }}
            />
          </Field>
          <RepoPicker value={repo} onChange={setRepo} serviceId={service.id} />
        </>
      ) : null}
      <Field label="移す理由">
        <Select aria-label="移す理由" value={picked} options={[...(to === null ? [] : optionsOf(SERVICE_MOVE_REASONS[to])), { value: OTHER_REASON, label: "その他" }]} onValueChange={(v) => setChoice(v)} />
      </Field>
      {picked === OTHER_REASON ? <TextField label="理由を書く" value={written} maxLength={2000} onChange={(e) => setWritten(e.target.value)} /> : null}
      <Stack direction="row" gap={2}>
        <Button variant={to === "dropped" || to === "closed" ? "danger" : "primary"} loading={busy} disabled={!input.success} onClick={() => void move()}>
          {to ? MOVE_LABEL[to] : "移す"}
        </Button>
      </Stack>
      {failure ? <MoveFailure failure={failure} /> : null}
    </Stack>
  );
}

interface MoveFailureProps {
  /** 段階を移せなかった理由 */
  failure: Failed;
}

/** 段階を移せなかった事を出す。決まりで断った refused は入口が返した説明 (足りない条件、重なる名前) を出し、ほかで変わった conflict にも説明を添える */
export function MoveFailure({ failure }: MoveFailureProps) {
  return <FailedAlert title="段階を移せませんでした" failure={failure} withDetail={failure.code === "conflict"} />;
}
