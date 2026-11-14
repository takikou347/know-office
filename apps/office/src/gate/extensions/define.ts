// 管理の拡張の形。拡張は extensions/<名前>/index.ts で defineExtension() の値を既定で出し、土台がルートとツールを付ける (サービスと拡張の 3.8)
import { EXTENSION_ID, EXTENSION_TOOL } from "@know-office/core";
import type { ZodType } from "zod";

/** 拡張ごとの置き場。R2 の `ext/<拡張 ID>/<キー>.json` に JSON を置き、ほかの拡張とゲートウェイの物には届かない */
export type ExtensionStore = {
  /** 置いた値を読む。無ければ null。読んだ値は拡張の Zod スキーマで確かめてから使う */
  get(key: string): Promise<unknown>;
  /** 値を置き換える */
  put(key: string, value: unknown): Promise<void>;
};

/** 拡張のルートとツールが受ける物。鍵、D1、DO、社員の DO は渡さない */
export type ExtensionContext = {
  /** 今の時刻 */
  now: number;
  /** その拡張の置き場 */
  store: ExtensionStore;
};

/** 拡張のルートで共通の項目。path は `/api/v1/ext/<拡張 ID>` の後ろ */
type RouteBase = {
  /** `/note` の形のパス */
  path: string;
  /** v1.yaml と同じ operationId */
  operationId: string;
  /** 要約 */
  summary: string;
  /** 返す data の Zod スキーマ */
  response: ZodType;
};

/** 拡張のルート。読む get と、置き換える put だけを持つ */
export type ExtensionRoute =
  | (RouteBase & {
      /** メソッド */
      method: "get";
      /** 中身 */
      run: (ctx: ExtensionContext) => Promise<unknown>;
    })
  | (RouteBase & {
      /** メソッド */
      method: "put";
      /** 本文の Zod スキーマ。土台が確かめてから run に渡す */
      body: ZodType;
      /** 中身。body は本文のスキーマを通した物 */
      run: (ctx: ExtensionContext, body: never) => Promise<unknown>;
    });

/** 拡張のツール。入力は schema を通してから run に渡す */
export type ExtensionTool = {
  /** 入力の Zod スキーマ */
  schema: ZodType;
  /** 中身。input は schema を通した物 */
  run: (ctx: ExtensionContext, input: never) => Promise<unknown>;
};

/** 拡張の定義 */
export type ExtensionDefinition = {
  /** 小文字の kebab-case の ID */
  id: string;
  /** 画面と一覧に出す名前 */
  title: string;
  /** オーナーの情報を扱うか */
  ownerData: boolean;
  /** `/api/v1/ext/<id>` の下のルート */
  routes: readonly ExtensionRoute[];
  /** 社員が使えるツール。名前は小文字の snake_case */
  tools: Readonly<Record<string, ExtensionTool>>;
};

const ROUTE_PATH = /^(?:\/[a-z\d]+(?:-[a-z\d]+)*)+$/;

/** defineExtension() を通した定義。読み込む時に、ほかの値を拡張と取り違えない */
const DEFINED = new WeakSet<object>();

/**
 * 拡張を定義する。ID、ツールの名前、パスの形を確かめる
 * @param def 拡張の定義
 * @returns 確かめた定義
 * @throws Error 形が違う時と、オーナーの情報を扱う時。項目ごとの暗号、パスキーの確認、読んだ記録の置き場ができるまで差し込ませない
 */
export function defineExtension(def: ExtensionDefinition): ExtensionDefinition {
  if (!EXTENSION_ID.test(def.id)) throw new Error(`拡張の ID の形が違う: ${def.id}`);
  if (def.ownerData) throw new Error(`オーナーの情報を扱う拡張はまだ差し込めない: ${def.id}`);
  for (const name of Object.keys(def.tools)) if (!EXTENSION_TOOL.test(name)) throw new Error(`拡張のツールの名前の形が違う: ${def.id} の ${name}`);
  for (const r of def.routes) if (!ROUTE_PATH.test(r.path)) throw new Error(`拡張のルートのパスの形が違う: ${def.id} の ${r.path}`);
  const frozen = Object.freeze({ ...def, routes: Object.freeze([...def.routes]), tools: Object.freeze({ ...def.tools }) });
  DEFINED.add(frozen);
  return frozen;
}

/**
 * 値が defineExtension() を通した定義かを見る
 * @param value 拡張のモジュールが出した値
 * @returns 定義なら true
 */
export function isExtension(value: unknown): value is ExtensionDefinition {
  return typeof value === "object" && value !== null && DEFINED.has(value);
}
