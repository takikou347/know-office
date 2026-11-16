// 入れた拡張の画面。拡張には、その拡張のルートを呼ぶ口だけを渡す。パスキーの確認は口が受け持つ
import { useContext, useMemo } from "react";
import { ApiContext } from "../../api.ts";
import { EXTENSION_SCREENS, ExtensionFetchContext, extensionApi } from "../../extensions.ts";
import { Section } from "../../parts/section.tsx";

export interface ExtensionPageProps {
  /** 拡張 ID */
  id: string;
}

/**
 * 入れた拡張の画面を出す。拡張には、その拡張のルートを呼ぶ口だけを渡す
 * @param props 拡張 ID
 * @param props.id 拡張 ID
 * @returns 拡張の画面
 */
export function ExtensionPage({ id }: ExtensionPageProps) {
  const origin = useContext(ExtensionFetchContext);
  const gate = useContext(ApiContext);
  // オーナーの情報を扱う拡張のルートはパスキーの確認を求めるので、確かめる時に使う入口の口も渡す
  const api = useMemo(() => extensionApi(id, origin, gate), [id, origin, gate]);
  const screen = EXTENSION_SCREENS[id];
  if (!screen) return null;
  return (
    <Section>
      <screen.Page api={api} />
    </Section>
  );
}
