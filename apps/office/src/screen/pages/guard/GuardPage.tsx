// 自動停止の画面。止めている物、止めた記録、基準、効き目、蒸留した学び。手で止めるボタン、効き目、蒸留した学びはゲートウェイを呼び、ほかは仮のデータ
import { Button, Card, Stack, Status, Table } from "knowidea-ui";
import { useState } from "react";
import { guardRules, stops } from "../../mock.ts";
import { Done, Part, Section } from "../../parts/section.tsx";
import { GuardEffectView, LessonList } from "./GuardLearning.tsx";
import { StopButton } from "./StopButton.tsx";

export function GuardPage() {
  const [resumed, setResumed] = useState<string[]>([]);
  const [done, setDone] = useState<string>();
  const rows = stops.map((x) => ({ ...x, state: resumed.includes(x.id) ? "再開した" : x.state }));
  const stopped = rows.filter((x) => x.state === "止めている");
  return (
    <Section>
      <Part title="止めている物">
        {stopped.length === 0 ? <p>止めている物は無い</p> : null}
        {stopped.map((x) => (
          <Card
            key={x.id}
            title={x.target}
            subtitle={x.time}
            badge={<Status kind="stopped" label="止めている" />}
            actions={
              <Button
                aria-label={`${x.target}を再開する`}
                onClick={() => {
                  setResumed((r) => [...r, x.id]);
                  setDone(`${x.target}を再開しました`);
                }}
              >
                再開する
              </Button>
            }
          >
            {x.reason}
          </Card>
        ))}
        <Done text={done} />
      </Part>
      <Part title="止めた記録">
        <Table
          label="止めた記録"
          rowKey={(r) => r.id}
          rows={rows}
          columns={[
            { key: "time", header: "時刻", numeric: true },
            { key: "target", header: "相手" },
            { key: "reason", header: "理由", wrap: true },
            { key: "state", header: "今" },
          ]}
        />
      </Part>
      <Part title="基準">
        <ul>
          {guardRules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Part>
      <Part title="効き目">
        <GuardEffectView />
      </Part>
      <Part title="蒸留した学び">
        <LessonList />
      </Part>
      <Stack direction="row" gap={2}>
        <StopButton scope="office" target="office" label="すべての社員を止める" />
      </Stack>
    </Section>
  );
}
