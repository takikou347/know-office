// セキュリティの画面。止めている物と再開、止めた記録と判定、基準、効き目、蒸留した学び、手で止めるボタン。どれもゲートウェイから読む (自動停止の 3.8)
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
      <Part title="止めている物">
        <StoppedList tick={tick} onChanged={reload} />
      </Part>
      <Part title="止めた記録">
        <StopHistory tick={tick} onChanged={reload} />
      </Part>
      <Part title="基準">
        <Thresholds />
      </Part>
      <Part title="効き目">
        <GuardEffectView />
      </Part>
      <Part title="蒸留した学び">
        <LessonList />
      </Part>
      <Part title="手で止める">
        <Stack direction="row" gap={2} wrap>
          {StaffId.options.map((id) => (
            <StopButton key={id} scope="staff" target={id} label={`${STAFF_LABEL[id]}を止める`} onStopped={reload} />
          ))}
          <StopButton scope="office" target="office" label="すべての社員を止める" onStopped={reload} />
        </Stack>
      </Part>
    </Section>
  );
}
