// 設定の画面の、全体のルールとサービスの初期値。勤務の時刻と、サービスが受け継ぐ 5 項目を読み、1 項目ずつ変える (サービスと拡張の 3.3、社員と勤怠の 2 章)
import { INHERITED_KEYS, Setting, WorkSchedule } from "@know-office/core";
import { Card, Checkbox, Stack, Status, TextField } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import { type CardProps, type PutSetting, RuleCard, same, type Saved, SaveBar } from "../../parts/rule-card.tsx";
import { Part } from "../../parts/section.tsx";

const SCHEDULE_KEY = "workday.schedule";
const DEFAULT_PREFIX = "service.";

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
          put={officePut(SCHEDULE_KEY)}
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
          if (!setting) return null;
          const badge = <Status kind={setting.inherited ? "neutral" : "info"} label={setting.inherited ? "組み込みの初期値" : `バージョン ${String(setting.version)}`} />;
          return <RuleCard key={`${name}:${String(tick)}`} name={name} setting={setting} put={officePut(setting.key)} badge={badge} onSaved={keep} onRefused={refused} />;
        })}
      </Part>
    </>
  );
}
