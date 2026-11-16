// 拡張の画面を集め、拡張の画面が自分のルートを呼ぶ口を渡す。土台のコードを直さずに画面を足せる (サービスと拡張の 3.8)
import type { Extension } from "@know-office/core";
import type { NavItem } from "knowidea-ui";
import { type ComponentType, createContext } from "react";
import { z, type ZodType } from "zod";
import type { Api, Fetch } from "./api.ts";
import { withStepUp } from "./parts/step-up.ts";
import type { ExtensionNav } from "./routes.ts";

/** 拡張の画面が自分のルート (`/api/v1/ext/<拡張 ID>` の下) を呼ぶ口。失敗と形の違う返事は null */
export type ExtensionApi = {
  /** 読む */
  get<T>(path: string, schema: ZodType<T>): Promise<T | null>;
  /** 置き換える */
  put<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T | null>;
};

/** 拡張の画面の部品が受ける物 */
export type ExtensionPageProps = {
  /** その拡張のルートを呼ぶ口 */
  api: ExtensionApi;
};

/** 拡張の画面。extensions/<名前>/screen.tsx が `screen` の名前で出す */
export type ExtensionScreen = {
  /** 切り替えの絵 */
  icon: NonNullable<NavItem["icon"]>;
  /** 画面の中身 */
  Page: ComponentType<ExtensionPageProps>;
};

const Module = z.object({ screen: z.object({ icon: z.string(), Page: z.unknown() }) });

/**
 * 拡張の画面のモジュールを集める。vite が組み立ての時に import.meta.glob を import に直す
 * @returns 拡張 ID から画面への対応
 */
function collect(): Record<string, ExtensionScreen> {
  const found: Record<string, unknown> = import.meta.glob("../extensions/*/screen.tsx", { eager: true });
  const out: Record<string, ExtensionScreen> = {};
  for (const [path, mod] of Object.entries(found)) {
    const id = /\/extensions\/([^/]+)\/screen\.tsx$/.exec(path)?.[1];
    if (id === undefined || !Module.safeParse(mod).success) throw new Error(`${path} は screen を出していない`);
    // 形は上で確かめ、型は ExtensionScreen に合わせて書かれている
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    out[id] = (mod as { screen: ExtensionScreen }).screen;
  }
  return out;
}

/** extensions/ から集めた拡張の画面 */
export const EXTENSION_SCREENS: Readonly<Record<string, ExtensionScreen>> = collect();

/**
 * 入れていて、画面を持つ拡張だけを、絵を付けて返す
 * @param extensions 入口が返した拡張
 * @returns 切り替えに並べる拡張
 */
export function withScreens(extensions: readonly Extension[]): ExtensionNav[] {
  return extensions.flatMap((e) => {
    const screen = EXTENSION_SCREENS[e.id];
    return e.enabled && screen ? [{ id: e.id, title: e.title, enabled: true, icon: screen.icon }] : [];
  });
}

/** 拡張の画面が入口を呼ぶ時に使う、入口の origin と fetch。サーバーで描く時とテストでは無い */
export const ExtensionFetchContext = createContext<{ base: string; fetch: Fetch } | null>(null);

const Envelope = z.object({ data: z.unknown() }).loose();

/**
 * 拡張のルートを呼ぶ口を作る。拡張のルートは拡張ごとに足すので入口の RPC の型に無く、返事は拡張の Zod スキーマで確かめる。
 * 入口がパスキーの確認を求めた時 (オーナーの情報を扱う拡張) は、確かめてから 1 度だけ呼び直す
 * @param id 拡張 ID
 * @param origin 入口の origin と fetch。無ければ呼ばずに null を返す
 * @param api パスキーで確かめる時に呼ぶ入口の口。無ければ確かめずに失敗にする
 * @returns 呼ぶ口
 */
export function extensionApi(id: string, origin: { base: string; fetch: Fetch } | null, api: Api | null = null): ExtensionApi {
  const call = async <T>(path: string, init: RequestInit, schema: ZodType<T>): Promise<T | null> => {
    if (!origin) return null;
    const send = () => origin.fetch(`${origin.base}/api/v1/ext/${id}${path}`, { credentials: "same-origin", ...init });
    const res = await (api ? withStepUp(api, send) : send()).catch(() => null);
    if (!res?.ok) return null;
    const body = Envelope.safeParse(await res.json().catch(() => null));
    const data = schema.safeParse(body.data?.data);
    return data.success ? data.data : null;
  };
  return {
    get: (path, schema) => call(path, {}, schema),
    put: (path, body, schema) => call(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, schema),
  };
}
