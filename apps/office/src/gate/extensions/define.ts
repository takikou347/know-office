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

/**
 * オーナーの情報の置き場。項目ごとに土台が暗号にして owner_data に置き、読むたびに owner_data_reads に残す。
 * ownerData の拡張のルートだけが受け、どのルートもパスキーの確認の後に動く。ツールは受けない
 */
export type OwnerDataStore = {
  /** 項目をまとめて読む。置いていない項目は持たない。全部を戻せた時だけ読んだ記録を残し、1 つでも戻せなければ何も残さずに投げる */
  get(fields: readonly string[]): Promise<Record<string, string>>;
  /** 渡した項目をまとめて置き換える。全部を 1 回のバッチで書き、途中で落ちても一部だけを残さない */
  put(values: Readonly<Record<string, string>>): Promise<void>;
};

/** 拡張のルートとツールが受ける物。鍵、D1、DO、社員の DO は渡さない */
export type ExtensionContext = {
  /** 今の時刻 */
  now: number;
  /** その拡張の置き場 */
  store: ExtensionStore;
  /** オーナーの情報の置き場。ownerData の拡張のルートだけが受け、ほかは null */
  ownerData: OwnerDataStore | null;
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
  /** 社員に見せる説明。省くと拡張の名前から作る */
  description?: string;
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
  /** オーナーの情報を扱うか。扱う拡張のルートはどれもパスキーの確認を求め、ctx.ownerData を受ける */
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
 * @throws Error ID、ツールの名前、パスの形が違う時
 */
export function defineExtension(def: ExtensionDefinition): ExtensionDefinition {
  if (!EXTENSION_ID.test(def.id)) throw new Error(`拡張の ID の形が違う: ${def.id}`);
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
