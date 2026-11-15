// 設定の画面。外の鍵の入れ直し、全体のルール、GitHub、セッション、拡張。拡張と鍵の入れ直しは入口を呼び、ほかは仮のデータ
import type { Extension } from "@know-office/core";
import { Button, Card, List } from "knowidea-ui";
import { useState } from "react";
import { sessions } from "../../mock.ts";
import type { ToggleExtension } from "../../parts/navigate.ts";
import { Part, Section } from "../../parts/section.tsx";
import { KeyReentry } from "./KeyReentry.tsx";

export interface SettingsPageProps {
  /** 入口が返した拡張 */
  extensions: readonly Extension[];
  /** 拡張を入れるか切る */
  toggleExtension: ToggleExtension;
}

export function SettingsPage({ extensions, toggleExtension }: SettingsPageProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ended, setEnded] = useState<string[]>([]);
  return (
    <Section>
      <KeyReentry />
      <Card
        title="全体のルール"
        headingLevel={2}
        meta={[
          { label: "勤務の始め", value: "9:00" },
          { label: "勤務の長さ", value: "8 時間" },
          { label: "延長の上限", value: "30 分" },
        ]}
      />
      <Card title="サービスの初期値" headingLevel={2} meta={[{ label: "見る役", value: "作る役と別のモデル" }]} />
      <Card title="GitHub" headingLevel={2} actions={<Button disabled>連携する</Button>}>
        アプリの中のボタン 1 つで繋ぐ。まだ動かない
      </Card>
      <Part title="セッションと鍵">
        <List
          label="セッション"
          items={sessions
            .filter((s) => !ended.includes(s.id))
            .map((s) => ({
              id: s.id,
              title: s.device,
              meta: s.current ? "この端末" : `最後 ${s.last}`,
              side: s.current ? undefined : (
                <Button variant="quiet" aria-label={`${s.device}のセッションを切る`} onClick={() => setEnded((e) => [...e, s.id])}>
                  切る
                </Button>
              ),
            }))}
        />
        <p>鍵は入口だけが持ち、画面には出しません</p>
      </Part>
      <Part title="拡張">
        {extensions.length === 0 ? (
          <p>拡張はありません</p>
        ) : (
          <List
            label="拡張"
            items={extensions.map((e) => ({
              id: e.id,
              title: e.title,
              meta: e.enabled ? "入れている" : "入れていない",
              side: (
                <Button
                  variant="secondary"
                  aria-label={`${e.title}を${e.enabled ? "外す" : "入れる"}`}
                  loading={busy === e.id}
                  onClick={() => {
                    setBusy(e.id);
                    void toggleExtension(e.id, !e.enabled).finally(() => setBusy(null));
                  }}
                >
                  {e.enabled ? "外す" : "入れる"}
                </Button>
              ),
            }))}
          />
        )}
        <p>外しても拡張のデータは消えず、入れ直すと戻ります</p>
      </Part>
    </Section>
  );
}
