// その他の画面の一覧。下の切り替えに入らない画面と、入れた拡張の画面へ移る
import type { Extension } from "@know-office/core";
import { List } from "knowidea-ui";
import { withScreens } from "../../extensions.ts";
import { Section } from "../../parts/section.tsx";
import { moreScreensWith } from "../../routes.ts";

export interface MorePageProps {
  /** 入口が返した拡張 */
  extensions: readonly Extension[];
}

export function MorePage({ extensions }: MorePageProps) {
  return (
    <Section>
      <List label="その他の画面" items={moreScreensWith(withScreens(extensions)).map((s) => ({ id: s.id, title: s.label, href: s.path }))} />
    </Section>
  );
}
