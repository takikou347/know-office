// 設定の 1 項目を変えるカードと、送る口。office の初期値 (設定の画面) とサービスごとの設定 (アイデアとサービスの画面) が同じ物を使う (サービスと拡張の 3.3)
import { INHERITED_SETTINGS, type InheritedKey, ReleaseCondition, RepoAction, Setting } from "@know-office/core";
import { Checkbox, Stack, Switch, TextField } from "knowidea-ui";
import { type ReactNode, useContext, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../api.ts";
import { type Failed, type Loaded, type Reply, send, useLoad } from "./load.tsx";
import { type SaveResult, SettingCard } from "./setting-card.tsx";

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

/**
 * 設定を 1 項目送り、変えた知らせの文か断られた理由を返す口を作る。守りを弱める変更と勤務を延ばす変更は、ゲートウェイがパスキーの確認を求める
 * @param api 入口を呼ぶ口。無ければ送らず読めなかった事にする
 * @param label 項目の名前
 * @param put 送る口
 * @param version 読んだ版
 * @param value 送る値
 * @param handlers 変えた後と断られた時に呼ぶ口
 * @returns 理由を受けて送る関数
 */
export function putSave(
  api: Api | null,
  label: string,
  put: PutSetting,
  version: number,
  value: unknown,
  handlers: { onSaved: Saved; onRefused: (failure: Failed) => void },
): (reason: string) => Promise<SaveResult> {
  return async (reason) => {
    if (!api) return { ok: false, failure: { code: "network", traceId: null } };
    const sent = await send(api, () => put(api, { version, value, reason }));
    if (!sent.ok) {
      handlers.onRefused(sent.failure);
      return sent;
    }
    const next = z.object({ data: Setting }).loose().parse(await sent.res.json()).data;
    handlers.onSaved(next);
    return { ok: true, done: `${label}を変えました (バージョン ${String(next.version)})` };
  };
}

/**
 * 断られた知らせの題。502 は設定を書けた後に GitHub へ掛けられなかった時なので、変えた事も伝える
 * @param label 項目の名前
 * @param failure 断られた理由
 * @returns 題
 */
export function refusalTitle(label: string, failure: Failed): string {
  return failure.code === "upstream_failed" ? `${label}は変えましたが、GitHub に掛けられませんでした` : `${label}を変えられませんでした`;
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
  /** 断られた時に呼ぶ。断られた理由を渡す */
  onRefused: (failure: Failed) => void;
  /** 作り直す前のカードで断られた理由 */
  refusal?: Failed | undefined;
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

/** 受け継ぐ項目ごとの 1 行の説明 */
const RULE_NOTE: Record<InheritedKey, string> = {
  actions: "社員がリポジトリでしてよい操作です",
  mergeWhen: "社員の PR を main に入れる前にそろえる条件です",
  deployWhen: "本番にデプロイする前にそろえる条件です",
  protectedPaths: "社員が書き換えられない道です。1 行に 1 つ書きます",
  paused: "止めている間は、サービスのタスクを進めません",
};

/**
 * 受け継ぐ項目の今の値を言葉にする
 * @param name 項目の名前
 * @param value 今の値
 * @returns 今の値の言葉
 */
export function ruleText(name: InheritedKey, value: unknown): string {
  if (name === "actions") {
    const actions = parseRule("actions", value) ?? [];
    return actions.length === 0 ? "できる操作はありません" : actions.map((a) => ACTION_LABEL[a]).join("、");
  }
  if (name === "mergeWhen" || name === "deployWhen") {
    const conditions = parseRule(name, value) ?? [];
    return conditions.length === 0 ? "条件はありません" : conditions.map((c) => CONDITION_LABEL[c]).join("、");
  }
  if (name === "protectedPaths") {
    const paths = parseRule("protectedPaths", value) ?? [];
    return paths.length === 0 ? "触れない所はありません" : paths.join("、");
  }
  return value === true ? "止めています" : "動かしています";
}

export interface RuleCardProps extends CardProps {
  /** 項目の名前 */
  name: InheritedKey;
  /** 送る口 */
  put: PutSetting;
  /** 見出しの隣の印。無ければ出さない */
  badge?: ReactNode;
}

/** 受け継ぐ項目の 1 つ。編集を押して選び直し、理由を書いて保存する。office の初期値とサービスごとの設定が使う */
export function RuleCard({ setting, name, put, badge, onSaved, onRefused, refusal }: RuleCardProps) {
  const api = useContext(ApiContext);
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
    <SettingCard
      title={label}
      description={RULE_NOTE[name]}
      badge={badge}
      current={ruleText(name, setting.value)}
      editor={editor}
      invalid={valid ? undefined : "条件は 1 つ以上選んでください"}
      ready={changed && valid}
      save={putSave(api, label, put, setting.version, draft, {
        onSaved: (next) => {
          setDraft(next.value);
          onSaved(next);
        },
        onRefused,
      })}
      refusedTitle={(failure) => refusalTitle(label, failure)}
      onCancel={() => setDraft(setting.value)}
      refusal={refusal}
    />
  );
}

/** 設定のカードを並べる画面が持つ物。読んだ設定、カードを作り直す番号、項目ごとの今の値と断られた理由、変えた時と断られた時の口 */
export interface SettingCards {
  /** 読んだ設定 */
  loaded: Loaded<Setting[]>;
  /** 読み直した設定が届くたびに増える番号。カードの key に入れ、読み直した今の値で選び欄を作り直す */
  round: number;
  /** 項目の今の値。変えた後は変えた値 */
  find: (key: string) => Setting | undefined;
  /** 項目の断られた理由。作り直したカードに渡す */
  refusalOf: (key: string) => Failed | undefined;
  /** 変えた時に呼ぶ */
  keep: Saved;
  /** 断られた時に呼ぶ口を作る。理由を残して読み直す */
  refuse: (key: string) => (failure: Failed) => void;
}

/**
 * 設定を読み、断られた時は理由を残したまま読み直し、届いた今の値でカードを作り直す。
 * 読み直す間は前の値のカードを残し、届いてから作り直すので、選び欄は入口の今の値になる (サービスと拡張の 3.3)
 * @param read 設定の一覧を読む
 * @returns 読んだ設定と、カードに渡す物
 */
export function useSettingCards(read: (api: Api) => Promise<Reply>): SettingCards {
  const [tick, setTick] = useState(0);
  const loaded = useLoad(z.array(Setting), read, tick);
  const [saved, setSaved] = useState<Record<string, Setting>>({});
  const [refusals, setRefusals] = useState<Record<string, Failed>>({});
  const [shown, setShown] = useState<{ data: Setting[]; round: number }>();
  // 読み直した値は useLoad が新しい並びで返す。届いた時だけ番号を進め、描く途中で直す (React の props から状態を直す形)
  if (loaded.state === "ok" && loaded.data !== shown?.data) setShown({ data: loaded.data, round: (shown?.round ?? 0) + 1 });
  return {
    loaded,
    round: shown?.round ?? 0,
    find: (key) => saved[key] ?? (loaded.state === "ok" ? loaded.data.find((s) => s.key === key) : undefined),
    refusalOf: (key) => refusals[key],
    keep: (next) => {
      setSaved((s) => ({ ...s, [next.key]: next }));
      setRefusals((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== next.key)));
    },
    refuse: (key) => (failure) => {
      setSaved({});
      setRefusals((r) => ({ ...r, [key]: failure }));
      setTick((t) => t + 1);
    },
  };
}
