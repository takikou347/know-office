// サービスごとの設定。リポジトリと担当の社員と、office の初期値から受け継ぐ 5 項目を読み、1 項目ずつ変える (サービスと拡張の 3.3)
import { INHERITED_KEYS, type Setting, StaffId } from "@know-office/core";
import { Field, Select, Stack, Status } from "knowidea-ui";
import { useContext, useState } from "react";
import { ApiContext } from "../../api.ts";
import { FailedAlert } from "../../parts/load.tsx";
import { type CardProps, type PutSetting, putSave, refusalTitle, RuleCard, useSettingCards } from "../../parts/rule-card.tsx";
import { SettingCard } from "../../parts/setting-card.tsx";
import { useStaffOptions } from "../../parts/staff-list.ts";
import { staffLabel } from "../guard/labels.ts";
import { UNSET } from "./labels.ts";
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

/** リポジトリ。編集を押して GitHub の触れるリポジトリから選び直す */
function RepoCard({ setting, put, onSaved, onRefused, refusal }: CardProps & { put: PutSetting }) {
  const api = useContext(ApiContext);
  const now = typeof setting.value === "string" ? setting.value : null;
  const [draft, setDraft] = useState<string | null>(now);
  return (
    <SettingCard
      title="リポジトリ"
      description="社員がこのサービスで触るリポジトリです"
      current={now ?? UNSET}
      editor={<RepoPicker value={draft} onChange={setDraft} />}
      ready={draft !== null && draft !== now}
      save={putSave(api, "リポジトリ", put, setting.version, draft, { onSaved, onRefused })}
      refusedTitle={(failure) => refusalTitle("リポジトリ", failure)}
      onCancel={() => setDraft(now)}
      refusal={refusal}
    />
  );
}

/** 担当の社員。編集を押して選び直す */
function StaffCard({ setting, put, onSaved, onRefused, refusal }: CardProps & { put: PutSetting }) {
  const api = useContext(ApiContext);
  const read = StaffId.safeParse(setting.value);
  const now = read.success ? read.data : null;
  const [draft, setDraft] = useState<StaffId | null>(now);
  const people = useStaffOptions();
  const editor = (
    <Field label="担当の社員">
      <Select
        aria-label="担当の社員"
        value={draft}
        placeholder="選ぶ"
        options={people}
        onValueChange={(v) => {
          const staff = StaffId.safeParse(v);
          if (staff.success) setDraft(staff.data);
        }}
      />
    </Field>
  );
  return (
    <SettingCard
      title="担当の社員"
      description="このサービスのタスクを受け持つ社員です"
      current={now ? (people.find((p) => p.value === now)?.label ?? staffLabel(now)) : UNSET}
      editor={editor}
      ready={draft !== null && draft !== now}
      save={putSave(api, "担当の社員", put, setting.version, draft, { onSaved, onRefused })}
      refusedTitle={(failure) => refusalTitle("担当の社員", failure)}
      onCancel={() => setDraft(now)}
      refusal={refusal}
    />
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
  const cards = useSettingCards((a) => a.api.v1.services[":serviceId"].settings.$get({ param: { serviceId }, query: { limit: "100" } }));
  const { loaded, round } = cards;
  if (loaded.state === "loading") return <p role="status">{name} の設定を読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title={`${name} の設定を読めませんでした`} failure={loaded} />;

  // 断られた時は理由を残したまま読み直し、届いた今の値でカードを作り直す
  const props = (setting: Setting) => ({
    setting,
    put: servicePut(serviceId, setting.key),
    refusal: cards.refusalOf(setting.key),
    onRefused: cards.refuse(setting.key),
    onSaved: (next: Setting) => {
      cards.keep(next);
      if (next.key === "repo" || next.key === "staffId") onChanged();
    },
  });
  const repo = cards.find("repo");
  const staff = cards.find("staffId");
  return (
    <Stack gap={3}>
      <p>変えていない項目には、設定の画面のサービスの初期値が効きます。守りを弱める変更はパスキーで確かめます</p>
      {repo ? <RepoCard key={`repo:${String(round)}`} {...props(repo)} /> : null}
      {staff ? <StaffCard key={`staff:${String(round)}`} {...props(staff)} /> : null}
      {INHERITED_KEYS.map((key) => {
        const setting = cards.find(key);
        if (!setting) return null;
        return <RuleCard key={`${key}:${String(round)}`} name={key} badge={inheritBadge(setting)} {...props(setting)} />;
      })}
    </Stack>
  );
}
