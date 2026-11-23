// ハーネスの画面。上から確かめて設定できるよう、今止まっている物と再開と手で止めるボタン、基準の設定、止めた記録と判定、効き目と蒸留した学びの順に置く。どれもゲートウェイから読む (自動停止の 3.6)
import { StaffId } from "@know-office/core";
import { Stack } from "knowidea-ui";
import { useCallback, useState } from "react";
import { Part, Section } from "../../parts/section.tsx";
import { GuardEffectView, LessonList } from "./GuardLearning.tsx";
import { StopHistory, StoppedList } from "./GuardStops.tsx";
import { STAFF_LABEL } from "./labels.ts";
import { StopButton } from "./StopButton.tsx";
import { Thresholds } from "./Thresholds.tsx";

export function GuardPage() {
  // 止めた、再開した、判定を付けた後に、止めている物と記録を読み直す
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return (
    <Section>
      <Part title="今止まっている物">
        <StoppedList tick={tick} onChanged={reload} />
        <Stack direction="row" gap={2} wrap>
          {StaffId.options.map((id) => (
            <StopButton key={id} scope="staff" target={id} label={`${STAFF_LABEL[id]}を止める`} onStopped={reload} />
          ))}
          <StopButton scope="office" target="office" label="すべての社員を止める" onStopped={reload} />
        </Stack>
      </Part>
      <Part title="基準の設定">
        <Thresholds />
      </Part>
      <Part title="止めた記録">
        <StopHistory tick={tick} onChanged={reload} />
      </Part>
      <Part title="学び">
        <GuardEffectView />
        <LessonList />
      </Part>
    </Section>
  );
}
