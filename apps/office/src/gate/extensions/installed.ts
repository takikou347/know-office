// extensions/<名前>/index.ts に置いた拡張を集める。土台のコードを直さずに拡張を足せる (サービスと拡張の 3.8)
import { type ExtensionDefinition, isExtension } from "./define.ts";

/**
 * 拡張のモジュールを集める。vite が組み立ての時に import.meta.glob を import に直す
 * @returns ファイルの道からモジュールへの対応
 */
function modules(): Record<string, unknown> {
  try {
    return import.meta.glob("../../extensions/*/index.ts", { eager: true });
  } catch {
    // wrangler (esbuild) だけで組む DO のテストの入口では import.meta.glob が無い。拡張を 1 つも入れない側に倒す
    return {};
  }
}

/**
 * 集めたモジュールから拡張の定義を ID の順に並べる
 * @param found ファイルの道からモジュールへの対応
 * @returns 拡張の定義
 * @throws Error 既定の値が defineExtension() の値でない時、ID が重なる時、ID とフォルダの名前が違う時
 */
export function collectExtensions(found: Record<string, unknown>): ExtensionDefinition[] {
  const out: ExtensionDefinition[] = [];
  for (const [path, mod] of Object.entries(found)) {
    const value: unknown = typeof mod === "object" && mod !== null && "default" in mod ? mod.default : undefined;
    if (!isExtension(value)) throw new Error(`${path} の既定の値が defineExtension() の値でない`);
    if (!path.endsWith(`/${value.id}/index.ts`)) throw new Error(`${path} の拡張の ID がフォルダの名前と違う: ${value.id}`);
    if (out.some((e) => e.id === value.id)) throw new Error(`拡張の ID が重なる: ${value.id}`);
    out.push(value);
  }
  return out.toSorted((a, b) => a.id.localeCompare(b.id));
}

/** 読み込んだ拡張。入れているかは `settings` の `extension.<ID>` で決める */
export const INSTALLED: readonly ExtensionDefinition[] = collectExtensions(modules());
