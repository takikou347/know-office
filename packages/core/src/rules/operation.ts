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
  "ext.tool",
  "secret.read",
  "guard.access",
  "staff.manage",
  "unknown",
] as const;

/** 操作の種類。`OPERATION_KINDS` の 1 つ */
export type OperationKind = (typeof OPERATION_KINDS)[number];

/** ルールで判断する操作。target は種類ごとの相手 (道、命令、URL、言葉、項目、拡張のツールの `<拡張 ID>.<ツール>`) で、入力に無ければ空 */
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
import { isStaffTool } from "./staff-tools.ts";

// 社員のツールは MCP の受け手 staff が出す。SDK には mcp__staff__<名前> で届く
const STAFF_TOOL = /^mcp__staff__(\w+)$/;
// 拡張のツールは同じ受け手が mcp__staff__ext__<拡張 ID>__<ツール> で出す。形は core の EXTENSION_ID と EXTENSION_TOOL と同じ
const EXT_TOOL = /^mcp__staff__ext__([a-z][a-z\d]*(?:-[a-z\d]+)*)__([a-z][a-z\d]*(?:_[a-z\d]+)*)$/;

/** 鍵の形の 1 つ。pattern は g を付けず、判断にそのまま使う。mask は記録で伏せる時の置き換え */
export type SecretShape = {
  /** 鍵の形 */
  pattern: RegExp;
  /** 伏せる時に置き換える文 */
  mask: string;
};

/**
 * 鍵を読もうとしたと判断し、記録でも伏せる鍵の形。判断と伏せの両方をこの並びから作り、形を足す時に片方を忘れない
 * 鍵の頭は語の途中に埋めても当たるよう \b を付けない。大文字と小文字は分けない
 */
export const SECRET_SHAPES: readonly SecretShape[] = [
  // GitHub と Anthropic の鍵の頭
  { pattern: /(?:gh[pousr]_|github_pat_|sk-ant-)[\w-]+/i, mask: "***" },
  { pattern: /\bBearer\s+[\w.~+/=-]+/i, mask: "***" },
  // 鍵の環境変数
  { pattern: /\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*\}?/i, mask: "***" },
  // 環境変数を全部出す命令。前後の区切りは残す
  { pattern: /(?<=^|[\s;&|(])(?:env|export\s+-p|set)(?=\s*(?:$|[;&|)]))/, mask: "***" },
  { pattern: /(?<=^|[\s;&|(])printenv\b/, mask: "***" },
  { pattern: /\/proc\/[^\s/]+\/environ/, mask: "***" },
];

const SECRET_TEXT = SECRET_SHAPES.map((s) => s.pattern);
const GUARD_TEXT = /\/(?:api|ws)\/v\d+\/(?:guard|stops)\b/;
const STAFF_TEXT = /\/(?:api|ws)\/v\d+\/staff\b/;

// 鍵らしい名前 (x-api-key、authorization、password、token、secret、api_key、access_token など) に入る語
const KEY_WORD = String.raw`(?:api[_-]?key|token|secret|password|passwd|authorization)`;
// 英数字、_、- の続き 1 つを、戻らずに終わりまで読む。先読みで取った物をそのまま当てるので、短くして試し直さない
const RUN = String.raw`(?=(?<run>[\w-]+))\k<run>`;
// 鍵らしい名前。続きの頭からだけ始め、鍵らしい語を含む続きの全体を名前にする。続きの途中から始めたり、名前を短くして試し直したりしないので、長い続きでも字数に比例した時間で終わる
const KEY_NAME = String.raw`(?<![\w-])(?=[\w-]*?${KEY_WORD})${RUN}`;
// - の後ろに鍵らしい語がある続き (--token、--with-token、foo-api-key)。最初の - より後ろだけを探す
const KEY_FLAG = String.raw`(?<![\w-])(?=\w*-[\w-]*?${KEY_WORD})${RUN}`;
// 引用符で囲んだ値。空白を含めて閉じる引用符まで、閉じていなければ行の終わりまで
const QUOTED = String.raw`"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)`;

/**
 * 名前の後の値を伏せる置き換えを作る。引用符で囲んだ値は引用符を残し、中を *** にする
 * @param prefix 残す頭 (名前と区切り) を返す
 * @returns replace に渡す関数
 */
function maskValue(prefix: (groups: string[]) => string): (match: string, ...groups: string[]) => string {
  return (match, ...groups) => {
    const head = prefix(groups);
    const quote = match.slice(head.length, head.length + 1);
    if (quote !== '"' && quote !== "'") return `${head}***`;
    const closed = match.length > head.length + 1 && match.endsWith(quote);
    return `${head}${quote}***${closed ? quote : ""}`;
  };
}

/** 記録で伏せる形と、置き換える文か関数 */
type Mask = readonly [RegExp, string | ((match: string, ...groups: string[]) => string)];

/** 記録に入れる前に伏せる形。伏せるだけの形の後に、判断と同じ鍵の形をつなぐ。モジュールの頭で 1 度だけ作る */
const MASKS: readonly Mask[] = [
  // URL の userinfo (user:pass@)。:// を見つけてから、スキームを後ろ向きに確かめる。語の境目ごとにスキームを読み直さない
  [/:\/\/(?<=\b[a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "://***@"],
  // --token 値 の形の引数
  [new RegExp(String.raw`(${KEY_FLAG}\s+)(?!-)(?:${QUOTED}|[^\s"'&;|]+)`, "gim"), maskValue(([head = ""]) => head)],
  // 名前 = 値 と 名前: 値。JSON の "名前": "値" と、authorization の Bearer と Basic も含める
  [new RegExp(String.raw`(${KEY_NAME}["']?\s*[:=]\s*)(?:${QUOTED}|(?:(?:Bearer|Basic|Token)\s+)?[^\s"'&,;}]+)`, "gim"), maskValue(([head = ""]) => head)],
  // JWT。続きの頭から最初の eyJ だけを試す。同じ続きの後ろの eyJ は、終わりが同じなので結果も同じ
  [/(?<![\w-])(?=(?<pre>[\w-]*?)eyJ)\k<pre>eyJ(?=(?<seg>[\w-]+))\k<seg>\.[\w-]+\.[\w-]*/g, "$<pre>***"],
  // AWS のアクセスキー
  [/AKIA[\dA-Z]{16}/g, "***"],
  // Slack のトークン
  [/xox[bp]-[\w-]+/g, "***"],
  // sk- で始まる鍵一般
  [/\bsk-[\w-]+/gi, "***"],
  ...SECRET_SHAPES.map((s): Mask => [new RegExp(s.pattern.source, `${s.pattern.flags}g`), s.mask]),
];

/** 記録と出来事に残す文の長さの上限 (字数)。長い命令で記録が膨らまないようにする */
export const MAX_RECORDED = 500;

/**
 * 文の中の鍵の形を伏せる。記録と自動停止の出来事に入れる前に通す
 * @param body 命令、URL、言葉、道
 * @returns 鍵の形を *** に置き換えた文
 */
export function maskSecrets(body: string): string {
  return MASKS.reduce((out, [pattern, replacement]) => (typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement)), body);
}

/**
 * 記録に残す文を作る。鍵の形を伏せてから 500 字で切り、サロゲートペアを割らない
 * @param body 命令、URL、言葉、道
 * @returns 伏せて切った文
 */
export function recordedText(body: string): string {
  return Array.from(maskSecrets(body)).slice(0, MAX_RECORDED).join("");
}

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
  const ext = EXT_TOOL.exec(toolName);
  if (ext) {
    const [, id = "", name = ""] = ext;
    // 拡張のツールも、鍵、自動停止、社員に触れる名前は社員のツールと同じ種類にして断る
    const hit = sensitive(name, "") ?? sensitive(id, "");
    return op(hit ?? "ext.tool", `${id}.${name}`);
  }
  // 形の違う拡張のツールの名前は、社員のツールと取り違えないよう知らないツールにする
  if (toolName.startsWith("mcp__staff__ext__")) return op("unknown", toolName);
  const staff = STAFF_TOOL.exec(toolName)?.[1];
  if (staff !== undefined) {
    // 決めた名前の社員のツールは、名前の頭 (staff_request の staff) で鍵や社員を触る試みと取り違えない。役で使えるかは decide が見る
    if (isStaffTool(staff)) return op("office.tool", staff);
    const hit = sensitive(staff, "");
    if (hit) return op(hit, staff);
    if (staff === "owner_info_read") return op("owner_info.read", text(input, "item"));
    return op("unknown", staff);
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
