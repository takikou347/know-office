// 設定の画面の、全体のルールとサービスの初期値。勤務の時刻と、サービスが受け継ぐ 5 項目を読み、1 項目ずつ変える (サービスと拡張の 3.3、社員と勤怠の 2 章)
import { INHERITED_KEYS, INHERITED_SETTINGS, type InheritedKey, ReleaseCondition, RepoAction, Setting, WorkSchedule } from "@know-office/core";
import { Alert, Button, Card, Checkbox, Stack, Status, Switch, TextField } from "knowidea-ui";
import { type ReactNode, useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { Part } from "../../parts/section.tsx";

const SCHEDULE_KEY = "workday.schedule";
const DEFAULT_PREFIX = "service.";

const ACTION_LABEL: Record<RepoAction, string> = { read: "読む", branch: "ブランチを作る", push: "push", pull_request: "プルリクエスト", merge: "main へのマージ", issue: "Issue" };
const CONDITION_LABEL: Record<ReleaseCondition, string> = { checks: "チェックの合格", reviewer: "レビュー担当の承認", owner: "オーナーの承認" };
const RULE_LABEL: Record<InheritedKey, string> = {
  actions: "できる操作",
  mergeWhen: "main にマージする条件",
  deployWhen: "本番にデプロイする条件",
  protectedPaths: "触れない所",
  paused: "手で止める",
};
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 変えた後に呼ぶ。新しい設定を渡す */
type Saved = (next: Setting) => void;

interface SaveBarProps {
  /** 項目の名前 */
  label: string;
  /** 設定のキー */
  settingKey: string;
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
function SaveBar({ label, settingKey, version, value, onSaved, onRefused }: SaveBarProps) {
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
    const sent = await send(api, () => api.api.v1.settings[":key"].$put({ param: { key: settingKey }, json: { version, value, reason: reason.trim() } }));
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
function same(a: unknown, b: unknown): boolean {
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

interface CardProps {
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

/** サービスの初期値の 1 項目。選び直して、理由を書いて変える */
function RuleCard({ setting, name, onSaved, onRefused }: CardProps & { name: InheritedKey }) {
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
    <Card title={label} headingLevel={3} badge={<Status kind={setting.inherited ? "neutral" : "info"} label={setting.inherited ? "組み込みの初期値" : `バージョン ${String(setting.version)}`} />}>
      <Stack gap={3}>
        {editor}
        {valid ? null : <p role="alert">条件は 1 つ以上選んでください</p>}
        <SaveBar
          label={label}
          settingKey={setting.key}
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

/** 勤務の時刻。始まり、終わり、曜日を変える。延ばす変更はパスキーで確かめる */
function ScheduleCard({ setting, onSaved, onRefused }: CardProps) {
  const read = WorkSchedule.safeParse(setting.value);
  const [draft, setDraft] = useState<WorkSchedule>(read.success ? read.data : { start: "09:00", end: "17:00", days: [] });
  const valid = WorkSchedule.safeParse(draft).success && draft.start !== draft.end && draft.days.length > 0;
  const changed = !same(draft, setting.value);
  return (
    <Card title="勤務の時刻" headingLevel={3} badge={<Status kind={setting.inherited ? "neutral" : "info"} label={setting.inherited ? "組み込みの初期値" : `バージョン ${String(setting.version)}`} />}>
      <Stack gap={3}>
        <Stack direction="row" gap={3} wrap>
          <TextField label="始まり (日本時間)" type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
          <TextField label="終わり (日本時間)" type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
        </Stack>
        <fieldset>
          <legend>勤務の曜日</legend>
          <Stack direction="row" gap={3} wrap>
            {WEEKDAYS.map((name, day) => (
              <Checkbox
                key={name}
                label={name}
                checked={draft.days.includes(day)}
                onCheckedChange={(on) => setDraft({ ...draft, days: WEEKDAYS.flatMap((_, d) => ((d === day ? on : draft.days.includes(d)) ? [d] : [])) })}
              />
            ))}
          </Stack>
        </fieldset>
        {valid ? null : <p role="alert">始まりと終わりを違う時刻にし、曜日を 1 つ以上選んでください</p>}
        <p>終わりが始まりより前なら、次の日の時刻まで働きます。勤務を延ばす変更はパスキーで確かめます</p>
        <SaveBar
          label="勤務の時刻"
          settingKey={SCHEDULE_KEY}
          version={setting.version}
          value={changed && valid ? draft : null}
          onSaved={(next) => {
            const parsed = WorkSchedule.safeParse(next.value);
            if (parsed.success) setDraft(parsed.data);
            onSaved(next);
          }}
          onRefused={onRefused}
        />
      </Stack>
    </Card>
  );
}

/** 全体のルール (勤務の時刻) とサービスの初期値 */
export function OfficeRules() {
  const [tick, setTick] = useState(0);
  const loaded = useLoad(z.array(Setting), (a) => a.api.v1.settings.$get({ query: { limit: "100" } }), tick);
  const [saved, setSaved] = useState<Record<string, Setting>>({});
  if (loaded.state === "loading") return <p role="status">全体のルールを読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="全体のルールを読めませんでした" failure={loaded} />;

  // 断られた時は読み直し、カードを作り直して、ほかの所で変わった今の値から選び直す。変えられた時はカードを残し、変えた事を出したままにする
  const refused = () => {
    setSaved({});
    setTick((t) => t + 1);
  };
  const keep: Saved = (next) => setSaved((s) => ({ ...s, [next.key]: next }));
  const find = (key: string) => saved[key] ?? loaded.data.find((s) => s.key === key);
  const schedule = find(SCHEDULE_KEY);
  return (
    <>
      <Part title="全体のルール">{schedule ? <ScheduleCard key={tick} setting={schedule} onSaved={keep} onRefused={refused} /> : null}</Part>
      <Part title="サービスの初期値">
        <p>サービスごとの設定で変えていない項目に、この値が効きます。守りを弱める変更はパスキーで確かめます</p>
        {INHERITED_KEYS.map((name) => {
          const setting = find(`${DEFAULT_PREFIX}${name}`);
          return setting ? <RuleCard key={`${name}:${String(tick)}`} name={name} setting={setting} onSaved={keep} onRefused={refused} /> : null;
        })}
      </Part>
    </>
  );
}
