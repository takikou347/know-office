// セキュリティの画面の基準。今の基準を表で出し、1 項目ずつパスキーで確かめて変える (自動停止の 3.2、3.6)
import { GuardThresholds } from "@know-office/core";
import { Alert, Button, Dialog, DialogClose, Stack, Table, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { shownValue, storedValue, THRESHOLD_ITEMS, thresholdText, unitLabel } from "./labels.ts";

/** 基準の表と、変える画面 */
export function Thresholds() {
  const api = useContext(ApiContext);
  const [tick, setTick] = useState(0);
  const loaded = useLoad(GuardThresholds, (a) => a.api.v1.guard.thresholds.$get(), tick);
  // 変えている項目のキー。変える画面を開いていない間は null
  const [key, setKey] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();
  if (loaded.state === "loading") return <p role="status">基準を読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="基準を読めませんでした" failure={loaded} />;

  const { version, values } = loaded.data;
  const rows = THRESHOLD_ITEMS.flatMap((item) => {
    const stored = values[item.key];
    return stored === undefined ? [] : [{ ...item, text: thresholdText(item.unit, stored) }];
  });
  const item = THRESHOLD_ITEMS.find((i) => i.key === key);
  const current = item ? values[item.key] : undefined;
  const entered = Number(value);
  const valid = item !== undefined && value.trim() !== "" && Number.isFinite(entered) && entered > 0 && reason.trim() !== "";

  const change = async () => {
    if (!api || !item || !valid) return;
    setBusy(true);
    setFailure(undefined);
    setDone(undefined);
    const sent = await send(api, () => api.api.v1.guard.thresholds.$put({ json: { version, values: { [item.key]: storedValue(item.unit, entered) }, reason: reason.trim() } }), { required: true });
    setBusy(false);
    // 断られた時も、ほかの所で変わった今の値を読み直す
    setTick((t) => t + 1);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    const next = z.object({ data: GuardThresholds }).loose().parse(await sent.res.json()).data;
    setDone(`${item.label}を ${thresholdText(item.unit, next.values[item.key] ?? 0)} に変えました (バージョン ${String(next.version)})`);
    setKey(null);
    setValue("");
    setReason("");
  };

  return (
    <Stack gap={3}>
      <p>基準のバージョン {version}</p>
      <Table
        label="基準"
        rowKey={(r) => r.key}
        rows={rows}
        columns={[
          { key: "label", header: "項目", wrap: true },
          { key: "text", header: "今の値", numeric: true },
          {
            key: "key",
            header: "変える",
            render: (r) => (
              <Button
                variant="secondary"
                aria-label={`${r.label}を変える`}
                onClick={() => {
                  setFailure(undefined);
                  setDone(undefined);
                  setValue("");
                  setKey(r.key);
                }}
              >
                変える
              </Button>
            ),
          },
        ]}
      />
      <Dialog
        open={key !== null}
        onOpenChange={(next) => {
          if (!next) setKey(null);
        }}
        title="基準を変える"
        description="変えると止める判断が変わるので、パスキーで確かめます。変えた者、前の値、後の値、理由が記録に残ります。"
        actions={
          <>
            <DialogClose variant="secondary">取り消す</DialogClose>
            <Button loading={busy} disabled={!valid} onClick={() => void change()}>
              変える
            </Button>
          </>
        }
      >
        <Stack gap={3}>
          {item ? <p>{item.label}</p> : null}
          {item && current !== undefined ? <p>今の値: {thresholdText(item.unit, current)}</p> : null}
          <TextField
            label={`新しい値 (${item ? unitLabel(item.unit) : ""})`}
            numeric
            inputMode="decimal"
            value={value}
            placeholder={item && current !== undefined ? String(shownValue(item.unit, current)) : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          <TextField label="変える理由" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          {failure ? <FailedAlert title="基準を変えられませんでした" failure={failure} /> : null}
        </Stack>
      </Dialog>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure && key === null ? <FailedAlert title="基準を変えられませんでした" failure={failure} /> : null}
    </Stack>
  );
}
