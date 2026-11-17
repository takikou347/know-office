// 補完の中継で、画面の道 (file:///repo/) と木の道を行き来させ、木の外の道と型の束に無い依存の知らせを画面に出さない (仕事とレビューの 3.6)
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 画面に見せる木の根 */
export const SCREEN_ROOT = "file:///repo/";

/** モジュールが見つからない知らせの code。型の束に無い依存は引けないので出さない */
const MISSING_MODULE_CODES = new Set([2307, 2792, 7016]);

/** 道を持つ項目 */
const URI_KEYS = new Set(["uri", "targetUri"]);


/** 捨てる印 */
export const DROP: unique symbol = Symbol("drop");

/**
 * 項目を持つ物かを確かめる
 * @param value 値
 * @returns 項目を持つ物なら true
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 正規表現の特別な字を逃がす
 * @param text 文字列
 * @returns 逃がした物
 */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * モジュールが見つからない知らせのうち、型の束に無い依存 (相対でも絶対でもない名前) の物かを返す
 * @param diagnostic 診断
 * @returns 出さない物なら true
 */
function missingPackage(diagnostic: unknown): boolean {
  if (!isRecord(diagnostic) || typeof diagnostic.code !== "number" || !MISSING_MODULE_CODES.has(diagnostic.code)) return false;
  const name = /'([^']+)'/.exec(typeof diagnostic.message === "string" ? diagnostic.message : "")?.[1];
  return name !== undefined && !name.startsWith(".") && !name.startsWith("/");
}

/** 診断の文の中の、引用符で囲んだ絶対の道 */
const QUOTED_PATH = /(['"])\/[^'"\s]*\1/g;

/**
 * 診断の文の中の絶対の道を伏せる。木の中と型の束の道は先に /repo/ に直してあるので残し、木の外 (tsconfig が指した /work など) の有る無しを画面に見せない
 * @param diagnostic 診断
 * @returns 伏せた物
 */
function hideOutsidePaths(diagnostic: unknown): unknown {
  if (!isRecord(diagnostic) || typeof diagnostic.message !== "string") return diagnostic;
  const message = diagnostic.message.replaceAll(QUOTED_PATH, (quoted, quote: string) => (quoted.startsWith(`${quote}/repo/`) || quoted === `${quote}/repo${quote}` ? quoted : `${quote}<木の外>${quote}`));
  return { ...diagnostic, message };
}

/**
 * 道を画面に直した後の診断の並びの文から、木の外の道を伏せる
 * @param value 知らせの params か、求めた診断の返事
 * @param key 診断の並びの項目
 */
export function hideOutside(value: unknown, key: "diagnostics" | "items"): void {
  if (!isRecord(value) || !Array.isArray(value[key])) return;
  value[key] = (value[key] as unknown[]).map((diagnostic) => {
    const hidden = hideOutsidePaths(diagnostic);
    if (!isRecord(hidden) || !Array.isArray(hidden.relatedInformation)) return hidden;
    return { ...hidden, relatedInformation: hidden.relatedInformation.map((related: unknown) => hideOutsidePaths(related)) };
  });
}


/**
 * 診断の並びから、型の束に無い依存が見つからない知らせを外す
 * @param value 知らせの params か、求めた診断の返事
 * @param key 診断の並びの項目
 * @returns 外した物
 */
export function withoutMissing(value: unknown, key: "diagnostics" | "items"): unknown {
  if (!isRecord(value)) return value;
  const list: unknown = value[key];
  if (!Array.isArray(list)) return value;
  return { ...value, [key]: list.filter((diagnostic: unknown) => !missingPackage(diagnostic)) };
}

/** 1 本の木の道の作り直し */
export class LspPaths {
  readonly #tree: string;
  readonly #typesRoots: string[];
  /** 文の中のワークスペースの道を画面の道に直す並び */
  readonly #hide: [RegExp, string][];

  /**
   * 木の道の作り直しを作る
   * @param tree 木の道。実の道 (realpath) で渡す
   * @param reviewRoot 木を置く所。ほかの木の道も画面に出さない
   * @param typesRoots 型の束の置き場。実の道で渡す
   */
  constructor(tree: string, reviewRoot: string, typesRoots: string[]) {
    this.#tree = tree;
    this.#typesRoots = typesRoots;
    this.#hide = [
      ...typesRoots.map((root): [RegExp, string] => [new RegExp(`${escapeRegExp(root)}(?:/[^\\s"'()]*)?/node_modules/`, "g"), "/repo/node_modules/"]),
      [new RegExp(escapeRegExp(tree), "g"), "/repo"],
      [new RegExp(`${escapeRegExp(reviewRoot)}/[0-9a-f-]{36}/[0-9a-f]{40}`, "g"), "/repo"],
    ];
  }

  /**
   * 文の中のワークスペースの道を画面の道に直す
   * @param value 値
   * @returns 直した物
   */
  hideText(value: unknown): unknown {
    if (typeof value === "string") return this.#hide.reduce((text, [pattern, to]) => text.replaceAll(pattern, to), value);
    if (Array.isArray(value)) return value.map((item) => this.hideText(item));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.hideText(item)]));
    return value;
  }

  /**
   * 画面の道 (file:///repo/...) を木の道に直す
   * @param uri 画面の道
   * @returns 木の道。木の外を指せば null
   */
  #toTree(uri: string): string | null {
    if (!uri.startsWith(SCREEN_ROOT)) return null;
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      return null;
    }
    const normal = posix.normalize(path);
    if (normal !== path || !normal.startsWith("/repo/") || normal.includes("\0")) return null;
    return pathToFileURL(`${this.#tree}${normal.slice("/repo".length)}`).href;
  }

  /**
   * tsc の道を画面の道に直す。木の中は file:///repo/、型の束の node_modules は file:///repo/node_modules/ にする
   * @param uri tsc の道
   * @returns 画面の道。木の外を指せば null
   */
  #toScreen(uri: string): string | null {
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      return null;
    }
    const tree = this.#tree;
    if (path.startsWith(`${tree}/`)) return pathToFileURL(`/repo${path.slice(tree.length)}`).href;
    for (const root of this.#typesRoots) {
      const at = path.lastIndexOf("/node_modules/");
      if (path.startsWith(`${root}/`) && at >= 0) return pathToFileURL(`/repo/node_modules/${path.slice(at + "/node_modules/".length)}`).href;
    }
    return null;
  }

  /**
   * 画面から来た params の道を木の道に直す
   * @param value 値
   * @returns 直した物。木の外を指す道があれば DROP
   */
  inward(value: unknown): unknown {
    if (Array.isArray(value)) {
      const items = value.map((item) => this.inward(item));
      return items.includes(DROP) ? DROP : items;
    }
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (URI_KEYS.has(key)) {
        const uri = typeof item === "string" ? this.#toTree(item) : null;
        if (uri === null) return DROP;
        out[key] = uri;
        continue;
      }
      const inner = this.inward(item);
      if (inner === DROP) return DROP;
      out[key] = inner;
    }
    return out;
  }

  /**
   * tsc から来た物の道を画面の道に直し、文の中のワークスペースの道を消す。木の外を指す物は、並びの中なら外し、ほかは持ち主ごと捨てる
   * @param value 値
   * @returns 直した物。捨てる時は DROP
   */
  outward(value: unknown): unknown {
    if (typeof value === "string") return this.hideText(value);
    if (Array.isArray(value)) return value.map((item) => this.outward(item)).filter((item) => item !== DROP);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (URI_KEYS.has(key) && typeof item === "string") {
        const uri = this.#toScreen(item);
        if (uri === null) return DROP;
        out[key] = uri;
        continue;
      }
      const inner = this.outward(item);
      if (inner === DROP) return DROP;
      out[key] = inner;
    }
    return out;
  }
}
