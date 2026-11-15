// 画面の区切りの共通の形。画面の幅の中に縦に並べる区画、見出しの付いた部分、押した事を知らせる帯
import { Alert, Container, Stack } from "knowidea-ui";
import type { ReactNode } from "react";

export interface SectionProps {
  /** 中身 */
  children: ReactNode;
}

/** 画面の幅の中に、中身を縦に並べる */
export function Section({ children }: SectionProps) {
  return (
    <Container size="lg">
      <Stack gap={6} style={{ paddingBlock: "var(--space-5)" }}>
        {children}
      </Stack>
    </Container>
  );
}

export interface PartProps {
  /** 見出し */
  title: string;
  /** 中身 */
  children: ReactNode;
}

/** 見出しの付いた部分 */
export function Part({ title, children }: PartProps) {
  return (
    <Stack as="section" gap={3}>
      <h2>{title}</h2>
      {children}
    </Stack>
  );
}

export interface DoneProps {
  /** 知らせる文。無ければ出さない */
  text?: string | undefined;
}

/** 押した事を知らせる帯。仮のデータなので記録しない事も添える */
export function Done({ text }: DoneProps) {
  if (!text) return null;
  return (
    <Alert tone="success" live>
      {text} (仮のデータなので記録しません)
    </Alert>
  );
}
