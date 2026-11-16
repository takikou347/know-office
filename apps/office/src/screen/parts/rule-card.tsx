// 設定の 1 項目を変えるカードと、理由の欄と変えるボタン。office の初期値 (設定の画面) とサービスごとの設定 (アイデアとサービスの画面) が同じ物を使う (サービスと拡張の 3.3)
import { INHERITED_SETTINGS, type InheritedKey, ReleaseCondition, RepoAction, Setting } from "@know-office/core";
import { Alert, Button, Card, Checkbox, Stack, Switch, TextField } from "knowidea-ui";
import { type ReactNode, useContext, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../api.ts";
import { type Failed, FailedAlert, type Reply, send } from "./load.tsx";

const ACTION_LABEL: Record<RepoAction, string> = { read: "読む", branch: "ブランチを作る", push: "push", pull_request: "プルリクエスト", merge: "main へのマージ", issue: "Issue" };
const CONDITION_LABEL: Record<ReleaseCondition, string> = { checks: "チェックの合格", reviewer: "レビュー担当の承認", owner: "オーナーの承認" };

/** 受け継ぐ項目の名前 */
export const RULE_LABEL: Record<InheritedKey, string> = {
  actions: "できる操作",
  mergeWhen: "main にマージする条件",
  deployWhen: "本番にデプロイする条件",
  protectedPaths: "触れない所",
  paused: "手で止める",
};

/** 変えた後に呼ぶ。新しい設定を渡す */
export type Saved = (next: Setting) => void;

/** 設定を 1 項目送る口。office の設定とサービスの設定で道が違う */
export type PutSetting = (api: Api, body: { version: number; value: unknown; reason: string }) => Promise<Reply & Response>;

interface SaveBarProps {
  /** 項目の名前 */
  label: string;
  /** 送る口。読んだ版、値、理由を送り、入口の返事を返す */
  put: PutSetting;
  /** 読んだ版 */
  version: number;
  /** 送る値。今の値と同じか、形が合わない間は null */
  value: unknown;
  /** 変えた後に呼ぶ */
  onSaved: Saved;
  /** 断られた時に呼ぶ。今の値を読み直すのに使う */
  onRefused: () => void;
}

/** 変える理由の欄と、変えるボタン。守りを弱める変更と勤務を延ばす変更は、ゲートウェイがパスキーの確認を求める */
export function SaveBar({ label, put, version, value, onSaved, onRefused }: SaveBarProps) {
  const api = useContext(ApiContext);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();

  const save = async () => {
    if (!api || value === null) return;
    setBusy(true);
    setDone(undefined);
    setFailure(undefined);
    const sent = await send(api, () => put(api, { version, value, reason: reason.trim() }));
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      onRefused();
      return;
    }
    const next = z.object({ data: Setting }).loose().parse(await sent.res.json()).data;
    setReason("");
    setDone(`${label}を変えました (バージョン ${String(next.version)})`);
    onSaved(next);
  };

  return (
    <Stack gap={2}>
      <TextField label={`${label}を変える理由`} value={reason} maxLength={2000} disabled={value === null} onChange={(e) => setReason(e.target.value)} />
      <Stack direction="row" gap={2}>
        <Button aria-label={`${label}を変える`} loading={busy} disabled={value === null || reason.trim() === ""} onClick={() => void save()}>
          変える
        </Button>
      </Stack>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title={`${label}を変えられませんでした`} failure={failure} /> : null}
    </Stack>
  );
}

/**
 * 2 つの値が同じ中身かを見る。並びは順も比べる
 * @param a 片方
 * @param b もう片方
 * @returns 同じなら true
 */
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface ChoicesProps<T extends string> {
  /** まとまりの名前 */
  legend: string;
  /** 選べる物 */
  options: readonly T[];
  /** 名前 */
  labels: Record<T, string>;
  /** 選んでいる物 */
  value: readonly T[];
  /** 選び直した時に呼ぶ。options の順に並べて渡す */
  onChange: (next: T[]) => void;
}

/** 重ねて選べるチェックボックスのまとまり */
function Choices<T extends string>({ legend, options, labels, value, onChange }: ChoicesProps<T>) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <Stack direction="row" gap={3} wrap>
        {options.map((o) => (
          <Checkbox key={o} label={labels[o]} checked={value.includes(o)} onCheckedChange={(on) => onChange(options.filter((x) => (x === o ? on : value.includes(x))))} />
        ))}
      </Stack>
    </fieldset>
  );
}

export interface CardProps {
  /** 読んだ設定 */
  setting: Setting;
  /** 変えた後に呼ぶ */
  onSaved: Saved;
  /** 断られた時に呼ぶ */
  onRefused: () => void;
}

/**
 * 受け継ぐ項目の今の値を、項目の形で読む。形が違えば null
 * @param key 項目の名前
 * @param value 読んだ値
 * @returns 項目の形の値
 */
function parseRule<K extends InheritedKey>(key: K, value: unknown): z.infer<(typeof INHERITED_SETTINGS)[K]> | null {
  const parsed = INHERITED_SETTINGS[key].safeParse(value);
  // 項目ごとの形は INHERITED_SETTINGS が決める
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed.success ? (parsed.data as z.infer<(typeof INHERITED_SETTINGS)[K]>) : null;
}

export interface RuleCardProps extends CardProps {
  /** 項目の名前 */
  name: InheritedKey;
  /** 送る口 */
  put: PutSetting;
  /** 見出しの隣の印 */
  badge: ReactNode;
}

/** 受け継ぐ項目の 1 つ。選び直して、理由を書いて変える。office の初期値とサービスごとの設定が使う */
export function RuleCard({ setting, name, put, badge, onSaved, onRefused }: RuleCardProps) {
  const [draft, setDraft] = useState<unknown>(setting.value);
  const label = RULE_LABEL[name];
  const valid = INHERITED_SETTINGS[name].safeParse(draft).success;
  const changed = !same(draft, setting.value);
  let editor: ReactNode = null;
  if (name === "actions") {
    editor = <Choices legend={label} options={RepoAction.options} labels={ACTION_LABEL} value={parseRule("actions", draft) ?? []} onChange={setDraft} />;
  } else if (name === "mergeWhen" || name === "deployWhen") {
    editor = <Choices legend={label} options={ReleaseCondition.options} labels={CONDITION_LABEL} value={parseRule(name, draft) ?? []} onChange={setDraft} />;
  } else if (name === "protectedPaths") {
    editor = (
      <TextField
        label="触れない所 (1 行に 1 つ)"
        multiline
        rows={4}
        value={(parseRule("protectedPaths", draft) ?? []).join("\n")}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value.split("\n").map((line) => line.trim()).filter((line) => line !== ""))}
      />
    );
  } else {
    editor = <Switch label="サービスを止めたままにする" checked={draft === true} onCheckedChange={setDraft} />;
  }
  return (
    <Card title={label} headingLevel={3} badge={badge}>
      <Stack gap={3}>
        {editor}
        {valid ? null : <p role="alert">条件は 1 つ以上選んでください</p>}
        <SaveBar
          label={label}
          put={put}
          version={setting.version}
          value={changed && valid ? draft : null}
          onSaved={(next) => {
            setDraft(next.value);
            onSaved(next);
          }}
          onRefused={onRefused}
        />
      </Stack>
    </Card>
  );
}
