// 設定の画面。外の鍵の入れ直し、全体のルールとサービスの初期値、GitHub、セッションとパスキー、拡張。どれもゲートウェイから読む
import type { Extension } from "@know-office/core";
import { Button, List } from "knowidea-ui";
import { useState } from "react";
import type { ToggleExtension } from "../../parts/navigate.ts";
import { Part, Section } from "../../parts/section.tsx";
import { DocsRepo } from "./DocsRepo.tsx";
import { GitHubCard } from "./GitHubCard.tsx";
import { KeyReentry } from "./KeyReentry.tsx";
import { OfficeRules } from "./OfficeRules.tsx";
import { Passkey } from "./Passkey.tsx";
import { Sessions } from "./Sessions.tsx";

export interface SettingsPageProps {
  /** 入口が返した拡張 */
  extensions: readonly Extension[];
  /** 拡張を入れるか切る */
  toggleExtension: ToggleExtension;
}

export function SettingsPage({ extensions, toggleExtension }: SettingsPageProps) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Section>
      <KeyReentry />
      <OfficeRules />
      <GitHubCard />
      <DocsRepo />
      <Part title="セッションと鍵">
        <Sessions />
        <Passkey />
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
