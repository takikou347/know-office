// 社員のツールの名前と入力を、ルールで判断する操作に直す (社員が考えるの 3.4)

/** 操作の種類の並び。足したら decide.ts の switch に判断を足さないと型のチェックが落ちる */
export const OPERATION_KINDS = [
  "file.read",
  "file.write",
  "shell.run",
  "web.fetch",
  "web.search",
  "agent.spawn",
  "owner_info.read",
  "office.tool",
  "secret.read",
  "guard.access",
  "staff.manage",
  "unknown",
] as const;

/** 操作の種類。`OPERATION_KINDS` の 1 つ */
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** ルールで判断する操作。target は種類ごとの相手 (道、命令、URL、言葉、項目) で、入力に無ければ空 */
export type Operation = {
  /** 操作の種類 */
  kind: OperationKind;
  /** ツールの名前 */
  tool: string;
  /** 主な相手 */
  target: string;
  /** 確かめる道。file の種類だけが持つ */
  paths: string[];
};

import { secretPath } from "./path.ts";
import { pathsOf, shellSegments } from "./shell.ts";

// 社員のツールは MCP の受け手 staff が出す。SDK には mcp__staff__<名前> で届く
const STAFF_TOOL = /^mcp__staff__(\w+)$/;
const OFFICE_TOOLS = ["checkpoint", "report", "ask_boss"];

// 鍵の形 (GitHub と Anthropic の鍵の頭、Bearer)、鍵の環境変数、環境変数を全部出す命令
const SECRET_TEXT = [
  /\b(?:gh[pousr]_|github_pat_|sk-ant-)[\w-]+/,
  /\bBearer\s+[\w.~+/=-]+/i,
  /\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*\}?/i,
  /(?:^|[\s;&|(])(?:env|export\s+-p|set)\s*(?:$|[;&|)])/,
  /(?:^|[\s;&|(])printenv\b/,
  /\/proc\/[^\s/]+\/environ/,
];
const GUARD_TEXT = /\/(?:api|ws)\/v\d+\/(?:guard|stops)\b/;
const STAFF_TEXT = /\/(?:api|ws)\/v\d+\/staff\b/;

/**
 * 入力から文字列の項目を取り出す
 * @param input ツールの入力
 * @param key 項目の名前
 * @returns 文字列ならその値、ほかは空
 */
function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

/**
 * 値が項目の並びかを確かめる
 * @param value ツールの入力
 * @returns 配列でないオブジェクトなら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 名前と入力から、鍵やセキュリティや社員に触る試みを先に見分ける
 * @param name ツールの名前 (mcp__staff__ を外した物)
 * @param body 外へ出うる文 (命令、URL、言葉、頼む事)
 * @returns 当たった種類。当たらなければ null
 */
function sensitive(name: string, body: string): OperationKind | null {
  if (/secret|vault/i.test(name) || SECRET_TEXT.some((p) => p.test(body))) return "secret.read";
  if (/^guard|stop/i.test(name) || GUARD_TEXT.test(body)) return "guard.access";
  if (/^staff/i.test(name) || STAFF_TEXT.test(body)) return "staff.manage";
  return null;
}

/**
 * ツールの名前と入力を操作に直す。知らないツールと形の違う入力は断られる形にする
 * @param toolName SDK が渡すツールの名前
 * @param toolInput SDK が渡すツールの入力
 * @returns 操作
 */
export function toOperation(toolName: string, toolInput: unknown): Operation {
  const input = isRecord(toolInput) ? toolInput : {};
  const op = (kind: OperationKind, target: string, paths: string[] = []): Operation => ({ kind, tool: toolName, target, paths });
  // 鍵の置き場を指す読み出しは secret.read にし、自動停止の sensitive_access に渡す
  const read = (target: string, paths: string[]): Operation => op(paths.some(secretPath) ? "secret.read" : "file.read", target, paths);
  const staff = STAFF_TOOL.exec(toolName)?.[1];
  if (staff !== undefined) {
    const hit = sensitive(staff, "");
    if (hit) return op(hit, staff);
    if (staff === "owner_info_read") return op("owner_info.read", text(input, "item"));
    return OFFICE_TOOLS.includes(staff) ? op("office.tool", staff) : op("unknown", staff);
  }
  switch (toolName) {
    case "Read":
      return read(text(input, "file_path"), [text(input, "file_path")]);
    case "Grep":
      // pattern は正規表現なので道として見ない。道を書かない時は作業の置き場 (/work) で探す
      return read(text(input, "pattern") && (text(input, "path") || "."), [text(input, "path") || "."]);
    case "Glob": {
      // Glob の型は道なので、外を指す形 (/、..、~、$) も置き場の頭から読んで確かめる
      const pattern = text(input, "pattern");
      const paths = [text(input, "path") || ".", pattern];
      return read(pattern && paths.join(" "), paths);
    }
    case "Write":
    case "Edit":
      return op("file.write", text(input, "file_path"), [text(input, "file_path")]);
    case "NotebookEdit":
      return op("file.write", text(input, "notebook_path"), [text(input, "notebook_path")]);
    case "Bash": {
      const command = text(input, "command");
      const words = (shellSegments(command) ?? []).flat();
      const secret = words.some((w) => secretPath(w) || pathsOf(w).some(secretPath));
      return op(secret ? "secret.read" : (sensitive("", command) ?? "shell.run"), command);
    }
    case "WebFetch":
      return op(sensitive("", text(input, "url")) ?? "web.fetch", text(input, "url"));
    case "WebSearch":
      return op(sensitive("", text(input, "query")) ?? "web.search", text(input, "query"));
    case "Task":
      return op(sensitive("", text(input, "prompt")) ?? "agent.spawn", text(input, "prompt"));
    default:
      return op("unknown", toolName);
  }
}
