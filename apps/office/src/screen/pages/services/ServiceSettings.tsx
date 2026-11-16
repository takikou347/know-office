// サービスごとの設定。リポジトリと担当の社員と、office の初期値から受け継ぐ 5 項目を読み、1 項目ずつ変える (サービスと拡張の 3.3)
import { INHERITED_KEYS, Setting, StaffId } from "@know-office/core";
import { Card, Field, Select, Stack, Status } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { type CardProps, type PutSetting, RuleCard, type Saved, SaveBar } from "../../parts/rule-card.tsx";
import { STAFF_LABEL } from "../guard/labels.ts";
import { RepoPicker } from "./StageActions.tsx";

/**
 * サービスの設定を 1 項目送る口を作る
 * @param serviceId サービス ID
 * @param key 設定のキー
 * @returns 送る口
 */
const servicePut =
  (serviceId: string, key: string): PutSetting =>
  (api, json) =>
    api.api.v1.services[":serviceId"].settings[":key"].$put({ param: { serviceId, key }, json });

/** 受け継いでいるかの印 */
const inheritBadge = (s: Setting) => <Status kind={s.inherited ? "neutral" : "info"} label={s.inherited ? "office の初期値と同じ" : "初期値から変えている"} />;

/** リポジトリ。GitHub の触れるリポジトリから選び直す */
function RepoCard({ setting, put, onSaved, onRefused }: CardProps & { put: PutSetting }) {
  const now = typeof setting.value === "string" ? setting.value : null;
  const [draft, setDraft] = useState<string | null>(now);
  return (
    <Card title="リポジトリ" headingLevel={3} badge={<Status kind="info" label={now ?? "まだ無い"} />}>
      <Stack gap={3}>
        <RepoPicker value={draft} onChange={setDraft} />
        <SaveBar label="リポジトリ" put={put} version={setting.version} value={draft !== null && draft !== now ? draft : null} onSaved={onSaved} onRefused={onRefused} />
      </Stack>
    </Card>
  );
}

/** 担当の社員 */
function StaffCard({ setting, put, onSaved, onRefused }: CardProps & { put: PutSetting }) {
  const now = StaffId.safeParse(setting.value);
  const [draft, setDraft] = useState<StaffId | null>(now.success ? now.data : null);
  return (
    <Card title="担当の社員" headingLevel={3} badge={<Status kind="info" label={now.success ? STAFF_LABEL[now.data] : "まだ無い"} />}>
      <Stack gap={3}>
        <Field label="担当の社員">
          <Select
            aria-label="担当の社員"
            value={draft}
            placeholder="選ぶ"
            options={StaffId.options.map((s) => ({ value: s, label: STAFF_LABEL[s] }))}
            onValueChange={(v) => {
              const staff = StaffId.safeParse(v);
              if (staff.success) setDraft(staff.data);
            }}
          />
        </Field>
        <SaveBar label="担当の社員" put={put} version={setting.version} value={draft !== null && draft !== setting.value ? draft : null} onSaved={onSaved} onRefused={onRefused} />
      </Stack>
    </Card>
  );
}

export interface ServiceSettingsProps {
  /** サービス ID */
  serviceId: string;
  /** サービスの名前 */
  name: string;
  /** リポジトリか担当を変えた後に呼ぶ。一覧と詳細を読み直すのに使う */
  onChanged: () => void;
}

/** サービスごとの設定 */
export function ServiceSettings({ serviceId, name, onChanged }: ServiceSettingsProps) {
  const [tick, setTick] = useState(0);
  const loaded = useLoad(z.array(Setting), (a) => a.api.v1.services[":serviceId"].settings.$get({ param: { serviceId }, query: { limit: "100" } }), tick);
  const [saved, setSaved] = useState<Record<string, Setting>>({});
  if (loaded.state === "loading") return <p role="status">{name} の設定を読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title={`${name} の設定を読めませんでした`} failure={loaded} />;

  // 断られた時は読み直し、ほかの所で変わった今の値から選び直す
  const refused = () => {
    setSaved({});
    setTick((t) => t + 1);
  };
  const keep: Saved = (next) => {
    setSaved((s) => ({ ...s, [next.key]: next }));
    if (next.key === "repo" || next.key === "staffId") onChanged();
  };
  const find = (key: string) => saved[key] ?? loaded.data.find((s) => s.key === key);
  const repo = find("repo");
  const staff = find("staffId");
  return (
    <Stack gap={3}>
      <p>変えていない項目には、設定の画面のサービスの初期値が効きます。守りを弱める変更はパスキーで確かめます</p>
      {repo ? <RepoCard key={`repo:${String(tick)}`} setting={repo} put={servicePut(serviceId, "repo")} onSaved={keep} onRefused={refused} /> : null}
      {staff ? <StaffCard key={`staff:${String(tick)}`} setting={staff} put={servicePut(serviceId, "staffId")} onSaved={keep} onRefused={refused} /> : null}
      {INHERITED_KEYS.map((key) => {
        const setting = find(key);
        if (!setting) return null;
        return <RuleCard key={`${key}:${String(tick)}`} name={key} setting={setting} put={servicePut(serviceId, key)} badge={inheritBadge(setting)} onSaved={keep} onRefused={refused} />;
      })}
    </Stack>
  );
}
