// 設定の画面の、全体のルールとサービスの初期値。勤務の時刻、Claude の API の月の予算、時間外の呼び出し、会話の言葉の指示と、サービスが受け継ぐ 5 項目を読み、1 項目ずつ変える (サービスと拡張の 3.3、社員と勤怠の 2 章)
import { ClaudeBudget, DEFAULT_CLAUDE_BUDGET, INHERITED_KEYS, type Setting, WorkSchedule } from "@know-office/core";
import { Checkbox, Stack, TextField, TimePicker } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { FailedAlert } from "../../parts/load.tsx";
import { type CardProps, type PutSetting, putSave, refusalTitle, RuleCard, same, useSettingCards } from "../../parts/rule-card.tsx";
import { SettingCard } from "../../parts/setting-card.tsx";
import { Part } from "../../parts/section.tsx";

const SCHEDULE_KEY = "workday.schedule";
const DEFAULT_PREFIX = "service.";
const BUDGET_KEY = "claude.budget";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/**
 * office の設定を 1 項目送る口を作る
 * @param key 設定のキー
 * @returns 送る口
 */
const officePut =
  (key: string): PutSetting =>
  (api, json) =>
    api.api.v1.settings[":key"].$put({ param: { key }, json });

/**
 * 勤務の時刻を言葉にする
 * @param schedule 勤務の時刻
 * @returns 「09:00 から 17:00 (日本時間)、月・火」のような文
 */
export function scheduleText(schedule: WorkSchedule): string {
  return `${schedule.start} から ${schedule.end} (日本時間)、${schedule.days.map((d) => WEEKDAYS[d]).join("・")}`;
}

/** 勤務の時刻。始まり、終わり、曜日を変える。延ばす変更はパスキーで確かめる */
function ScheduleCard({ setting, onSaved, onRefused, refusal }: CardProps) {
  const api = useContext(ApiContext);
  const read = WorkSchedule.safeParse(setting.value);
  const now: WorkSchedule = read.success ? read.data : { start: "09:00", end: "17:00", days: [] };
  const [draft, setDraft] = useState<WorkSchedule>(now);
  const valid = WorkSchedule.safeParse(draft).success && draft.start !== draft.end && draft.days.length > 0;
  const changed = !same(draft, setting.value);
  const editor = (
    <>
      <Stack direction="row" gap={3} wrap>
        <TimePicker label="始まり (日本時間)" value={draft.start} onValueChange={(start) => setDraft({ ...draft, start: start ?? draft.start })} />
        <TimePicker label="終わり (日本時間)" value={draft.end} onValueChange={(end) => setDraft({ ...draft, end: end ?? draft.end })} />
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
      <p>勤務を延ばす変更はパスキーで確かめます</p>
    </>
  );
  return (
    <SettingCard
      title="勤務の時刻"
      description="社員が働く時刻と曜日です。終わりが始まりより前なら、次の日のその時刻まで働きます"
      current={read.success ? scheduleText(read.data) : "勤務の時刻はありません"}
      editor={editor}
      invalid={valid ? undefined : "始まりと終わりを違う時刻にし、曜日を 1 つ以上選んでください"}
      ready={changed && valid}
      save={putSave(api, "勤務の時刻", officePut(SCHEDULE_KEY), setting.version, draft, {
        onSaved: (next) => {
          const parsed = WorkSchedule.safeParse(next.value);
          if (parsed.success) setDraft(parsed.data);
          onSaved(next);
        },
        onRefused,
      })}
      refusedTitle={(failure) => refusalTitle("勤務の時刻", failure)}
      onCancel={() => setDraft(now)}
      refusal={refusal}
    />
  );
}

/** Claude の API の月の予算。月の額と 1 タスクの上限を変える。増やす変更はパスキーで確かめる */
function BudgetCard({ setting, onSaved, onRefused, refusal }: CardProps) {
  const api = useContext(ApiContext);
  const read = ClaudeBudget.safeParse(setting.value);
  const now = read.success ? read.data : DEFAULT_CLAUDE_BUDGET;
  const [monthly, setMonthly] = useState(String(now.monthlyUsd));
  const [taskMax, setTaskMax] = useState(String(now.taskMaxUsd));
  const next = ClaudeBudget.safeParse({ monthlyUsd: Number(monthly), taskMaxUsd: Number(taskMax) });
  const changed = next.success && !same(next.data, setting.value);
  const editor = (
    <>
      <Stack direction="row" gap={3} wrap>
        <TextField label="月の予算 (ドル)" type="number" inputMode="decimal" min={1} step="any" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        <TextField label="1 タスクの上限 (ドル)" type="number" inputMode="decimal" min={0.1} step="any" value={taskMax} onChange={(e) => setTaskMax(e.target.value)} />
      </Stack>
      <p>Console の上限より下に置いてください。増やす変更はパスキーで確かめます</p>
    </>
  );
  return (
    <SettingCard
      title="Claude の API の月の予算"
      description="今月の残りを残りの日数で割った額が今日の配分です。配分に届いた社員は新しい呼び出しを始めず、明日の勤務で続けます。1 タスクの費用が上限を超えたら、そのタスクを止めます"
      current={`月 ${String(now.monthlyUsd)} ドル、1 タスク ${String(now.taskMaxUsd)} ドルまで`}
      editor={editor}
      invalid={next.success ? undefined : "どちらも 0 より大きい額にしてください"}
      ready={changed}
      save={putSave(api, "月の予算", officePut(BUDGET_KEY), setting.version, next.success ? next.data : null, {
        onSaved: (saved) => {
          const parsed = ClaudeBudget.safeParse(saved.value);
          if (parsed.success) {
            setMonthly(String(parsed.data.monthlyUsd));
            setTaskMax(String(parsed.data.taskMaxUsd));
          }
          onSaved(saved);
        },
        onRefused,
      })}
      refusedTitle={(failure) => refusalTitle("月の予算", failure)}
      onCancel={() => {
        setMonthly(String(now.monthlyUsd));
        setTaskMax(String(now.taskMaxUsd));
      }}
      refusal={refusal}
    />
  );
}

/** 費用の出る口の設定の、画面に出す言葉と回数の上限 */
type SwitchText = {
  /** 設定のキー */
  key: string;
  /** カードの題 */
  title: string;
  /** 開くかのチェックボックスの言葉 */
  check: string;
  /** 回数の欄の言葉 */
  perDayLabel: string;
  /** 回数の上限 */
  max: number;
  /** 見出しの下の 1 行の説明 */
  description: string;
  /** 編集の間に出す、費用と確かめ方の説明 */
  note: string;
};

/** 時間外の呼び出しと会話の言葉の指示 */
const SWITCHES: readonly SwitchText[] = [
  {
    key: "workday.offHoursCall",
    title: "時間外の呼び出し",
    description: "勤務の時間の外に話しかけた時に、退勤した社員を呼び出します",
    check: "勤務の時間の外に話しかけたら社員を呼び出す",
    perDayLabel: "1 日の回数 (社員ごと)",
    max: 10,
    note: "呼び出すと Claude の費用が出ます。1 回は 2 時間までです。取るタスクの無い社員と、話しかけた言葉で今日を休みにした社員は呼び出しません。開く変更と回数を増やす変更はパスキーで確かめます",
  },
  {
    key: "workday.chatOrders",
    title: "会話の言葉の指示",
    description: "話しかけた言葉から、休み、早退、延長の指示を読み取ります",
    check: "話しかけた言葉から休み、早退、延長の指示を読み取る",
    perDayLabel: "1 日の回数 (全員で)",
    max: 100,
    note: "開くと話しかけるたびに Claude (Haiku) の費用が出ます。延長はパスキーで確かめたすぐ後の言葉だけで出します。開く変更と回数を増やす変更はパスキーで確かめます",
  },
  {
    key: "guard.review",
    title: "止めた記録をレビュー担当に聞く",
    description: "タスクか社員を止めた時に、止めた記録をレビュー担当に読ませます",
    check: "タスクか社員を止めたら、止めた記録をレビュー担当に読ませ、問題が無ければ再開する",
    perDayLabel: "1 日の回数 (全員で)",
    max: 50,
    note: "開くと止めるたびに Claude (Sonnet) の費用が出ます。答えが無い時と回数を使い切った時は、オーナーが再開するまで止めたままです。開く変更と回数を増やす変更はパスキーで確かめます",
  },
];

/** 開くか閉じるかと 1 日の回数 */
const SwitchValue = z.object({ enabled: z.boolean(), perDay: z.number().int().min(1) }).strict();
type SwitchValue = z.infer<typeof SwitchValue>;

/** 費用の出る口のカード。開くと Claude の費用が出るので、開く変更と回数を増やす変更はパスキーで確かめる */
function SwitchCard({ text, setting, onSaved, onRefused, refusal }: CardProps & { text: SwitchText }) {
  const api = useContext(ApiContext);
  const read = SwitchValue.safeParse(setting.value);
  const now: SwitchValue = read.success ? read.data : { enabled: false, perDay: 1 };
  const [draft, setDraft] = useState<SwitchValue>(now);
  const [perDay, setPerDay] = useState(String(draft.perDay));
  const next = SwitchValue.safeParse({ ...draft, perDay: Number(perDay) });
  const fits = next.success && next.data.perDay <= text.max;
  const changed = fits && !same(next.data, setting.value);
  const editor = (
    <>
      <Checkbox label={text.check} checked={draft.enabled} onCheckedChange={(on) => setDraft({ ...draft, enabled: on })} />
      <TextField label={text.perDayLabel} type="number" inputMode="numeric" min={1} max={text.max} value={perDay} onChange={(e) => setPerDay(e.target.value)} />
      <p>{text.note}</p>
    </>
  );
  return (
    <SettingCard
      title={text.title}
      description={text.description}
      current={now.enabled ? `使う。1 日 ${String(now.perDay)} 回まで` : "使わない"}
      editor={editor}
      invalid={fits ? undefined : `1 日の回数は 1 から ${String(text.max)} にしてください`}
      ready={changed}
      save={putSave(api, text.title, officePut(text.key), setting.version, next.success ? next.data : null, {
        onSaved: (saved) => {
          const parsed = SwitchValue.safeParse(saved.value);
          if (parsed.success) {
            setDraft(parsed.data);
            setPerDay(String(parsed.data.perDay));
          }
          onSaved(saved);
        },
        onRefused,
      })}
      refusedTitle={(failure) => refusalTitle(text.title, failure)}
      onCancel={() => {
        setDraft(now);
        setPerDay(String(now.perDay));
      }}
      refusal={refusal}
    />
  );
}

/** 全体のルール (勤務の時刻、月の予算、時間外の呼び出し、会話の言葉の指示) とサービスの初期値 */
export function OfficeRules() {
  const cards = useSettingCards((a) => a.api.v1.settings.$get({ query: { limit: "100" } }));
  const { loaded, round } = cards;
  if (loaded.state === "loading") return <p role="status">全体のルールを読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="全体のルールを読めませんでした" failure={loaded} />;

  // 断られた時は理由を残したまま読み直し、届いた今の値でカードを作り直す。変えられた時はカードを残し、変えた事を出したままにする
  const props = (setting: Setting) => ({ setting, onSaved: cards.keep, onRefused: cards.refuse(setting.key), refusal: cards.refusalOf(setting.key) });
  const schedule = cards.find(SCHEDULE_KEY);
  const budget = cards.find(BUDGET_KEY);
  return (
    <>
      <Part title="全体のルール">
        {schedule ? <ScheduleCard key={round} {...props(schedule)} /> : null}
        {budget ? <BudgetCard key={`${BUDGET_KEY}:${String(round)}`} {...props(budget)} /> : null}
        {SWITCHES.map((text) => {
          const setting = cards.find(text.key);
          return setting ? <SwitchCard key={`${text.key}:${String(round)}`} text={text} {...props(setting)} /> : null;
        })}
      </Part>
      <Part title="サービスの初期値">
        <p>サービスごとの設定で変えていない項目に、この値が効きます。守りを弱める変更はパスキーで確かめます</p>
        {INHERITED_KEYS.map((name) => {
          const setting = cards.find(`${DEFAULT_PREFIX}${name}`);
          if (!setting) return null;
          return <RuleCard key={`${name}:${String(round)}`} name={name} put={officePut(setting.key)} {...props(setting)} />;
        })}
      </Part>
    </>
  );
}
