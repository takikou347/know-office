// 設定の画面のセッション。端末ごとの一覧を出し、1 つずつでも、この端末のほかをすべてでも切る (ログインと記録の 3.2)
import { Session } from "@know-office/core";
import { Alert, Button, List, Stack } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const DEVICES: readonly [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Mac OS X|Macintosh/, "Mac"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/**
 * User-Agent から端末とブラウザーの名前を作る。分からない時は「分からない端末」
 * @param userAgent ログインした時の User-Agent
 * @returns 「Mac の Chrome」のような名前
 */
export function deviceName(userAgent: string): string {
  const device = DEVICES.find(([pattern]) => pattern.test(userAgent))?.[1];
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (device && browser) return `${device} の ${browser}`;
  return device ?? browser ?? "分からない端末";
}

/** ログインセッションの一覧と、切るボタン */
export function Sessions() {
  const api = useContext(ApiContext);
  const [tick, setTick] = useState(0);
  const loaded = useLoad(z.array(Session), (a) => a.api.v1.sessions.$get({ query: { limit: "100" } }), tick);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();
  if (loaded.state === "loading") return <p role="status">セッションを読んでいます</p>;
  if (loaded.state === "failed") return <FailedAlert title="セッションを読めませんでした" failure={loaded} />;

  const end = async (id: string, text: string, call: (a: Api) => Promise<Response>) => {
    if (!api) return;
    setBusy(id);
    setDone(undefined);
    setFailure(undefined);
    const sent = await send(api, () => call(api));
    setBusy(null);
    if (sent.ok) setDone(text);
    else setFailure(sent.failure);
    // 切れなかった時も、もう終わっていたセッションを一覧から外すために読み直す
    setTick((t) => t + 1);
  };

  const others = loaded.data.filter((s) => !s.current);
  return (
    <Stack gap={3}>
      <List
        label="セッション"
        items={loaded.data.map((s) => {
          const name = deviceName(s.userAgent);
          return {
            id: s.id,
            title: s.current ? `${name} (この端末)` : name,
            meta: `${jstDateTime(s.createdAt)} にログイン、送信元 ${s.ip} (${s.country})`,
            side: s.current ? undefined : (
              <Button
                variant="quiet"
                aria-label={`${jstDateTime(s.createdAt)} にログインした${name}のセッションを切る`}
                loading={busy === s.id}
                disabled={busy !== null && busy !== s.id}
                onClick={() => void end(s.id, `${name}のセッションを切りました`, (a) => a.api.v1.sessions[":sessionId"].$delete({ param: { sessionId: s.id } }))}
              >
                切る
              </Button>
            ),
          };
        })}
      />
      <Stack direction="row" gap={2}>
        <Button
          variant="secondary"
          loading={busy === "others"}
          disabled={others.length === 0 || (busy !== null && busy !== "others")}
          onClick={() => void end("others", "この端末のほかのセッションをすべて切りました", (a) => a.api.v1.sessions.$delete())}
        >
          ほかのセッションをすべて切る
        </Button>
      </Stack>
      {done ? (
        <Alert tone="success" live>
          {done}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="セッションを切れませんでした" failure={failure} /> : null}
    </Stack>
  );
}
