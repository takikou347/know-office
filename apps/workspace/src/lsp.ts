// エディタの補完の中継。画面の JSON-RPC を絞って道を作り直し、レビューの木で動かす tsc --lsp との間を中継する (社員が考えるの 2 章、仕事とレビューの 3.6)
import { pathToFileURL } from "node:url";
import { DROP, hideOutside, isRecord, LspPaths, withoutMissing } from "./lsp-paths.ts";
import { procRss, type TscProcess, TSC_RSS_LIMIT_BYTES } from "./lsp-tsc.ts";

/** RSS を読む間 */
export const RSS_CHECK_MS = 10_000;
/** 画面から送りが無ければ閉じるまでの時間 */
export const LSP_IDLE_MS = 10 * 60_000;
/** tsc から受ける 1 件の上限 (4MiB)。ゲートウェイの下りの上限と同じ */
export const TSC_MESSAGE_BYTES = 4 * 1024 * 1024;

/** 画面から tsc へ通す method。初期化、ファイルを開く、変える、閉じる、候補、候補の詳しい中身、型と説明、定義、診断、取り消し、終わり */
export const SCREEN_METHODS = [
  "initialize",
  "initialized",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/completion",
  "completionItem/resolve",
  "textDocument/hover",
  "textDocument/definition",
  "textDocument/diagnostic",
  "$/cancelRequest",
  "shutdown",
  "exit",
] as const;

/** 画面に渡すクライアントの機能。画面が送った物は使わない */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false },
    completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail"] } } },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: false },
    diagnostic: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true },
  },
  workspace: { configuration: true, workspaceFolders: false },
} as const;

/** JSON-RPC の誤りの code (JSON-RPC 2.0 の 5.1) */
const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 } as const;

/** LspSession の依り所 */
export type LspSessionDeps = {
  /** 木の道。実の道 (realpath) で渡す */
  tree: string;
  /** 木を置く所。ほかの木の道も画面に出さない */
  reviewRoot: string;
  /** 型の束の置き場。実の道で渡し、この下の node_modules の道を file:///repo/node_modules/ に直す */
  typesRoots: string[];
  /** 動かした tsc */
  tsc: TscProcess;
  /** 画面へ 1 件送る */
  send: (text: string) => void;
  /** 画面との接続を閉じる */
  close: (code: number, reason: string) => void;
  /** tsc の RSS を読む。省くと /proc/<pid>/status */
  readRss?: (pid: number) => number | null;
  /** 終えた時に呼ぶ */
  onEnd?: () => void;
};


/** 画面と tsc の間の 1 本の中継。画面の求めを絞り、道を木と画面の間で作り直す */
export class LspSession {
  readonly #deps: LspSessionDeps;
  /** 画面が求めて、tsc がまだ返していない物。id の JSON と method */
  readonly #pending = new Map<string, string>();
  /** 画面に渡した候補の data の代わりの番号と、元の data */
  readonly #completionData = new Map<string, unknown>();
  #completionSeq = 0;
  #ended = false;
  #idle: ReturnType<typeof setTimeout> | undefined;
  readonly #rssTimer: ReturnType<typeof setInterval>;
  #buffer = Buffer.alloc(0);
  /** 道の作り直し */
  readonly #paths: LspPaths;

  /**
   * 中継を始め、RSS の見張りと使われない時の待ちを始める
   * @param deps 木、tsc、画面への送り
   */
  constructor(deps: LspSessionDeps) {
    this.#deps = deps;
    this.#paths = new LspPaths(deps.tree, deps.reviewRoot, deps.typesRoots);
    deps.tsc.stdout.on("data", (chunk: Buffer) => this.#onTscData(chunk));
    deps.tsc.once("exit", () => this.#close(1011, "tsc が止まった"));
    deps.tsc.stdin.on("error", () => this.#close(1011, "tsc が止まった"));
    const readRss = deps.readRss ?? procRss;
    this.#rssTimer = setInterval(() => {
      const rss = deps.tsc.pid === undefined ? null : readRss(deps.tsc.pid);
      if (rss !== null && rss > TSC_RSS_LIMIT_BYTES) this.#close(1011, "tsc のメモリが上限を超えた");
    }, RSS_CHECK_MS);
    this.#armIdle();
  }

  /**
   * 画面から来た 1 件を受け、許した物だけを道を木に直して tsc に送る
   * @param text JSON-RPC の 1 件
   */
  fromScreen(text: string): void {
    if (this.#ended) return;
    this.#armIdle();
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.#reply(null, RPC.parse, "JSON として読めない");
      return;
    }
    if (!isRecord(message)) {
      this.#reply(null, RPC.invalidRequest, "JSON-RPC の 1 件でない");
      return;
    }
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    // 返事の形の物 (method の無い物) は、tsc の要求にワークスペースが答えるので通さない
    if (typeof message.method !== "string") return;
    const method = message.method;
    if (!(SCREEN_METHODS as readonly string[]).includes(method)) {
      if (id !== undefined) this.#reply(id, RPC.methodNotFound, "許していない method");
      return;
    }
    let params: unknown = message.params;
    if (method === "initialize") {
      const root = pathToFileURL(this.#deps.tree).href;
      params = { processId: null, clientInfo: { name: "know-office" }, rootUri: root, workspaceFolders: [{ uri: root, name: "repo" }], capabilities: CLIENT_CAPABILITIES };
    } else if (method === "completionItem/resolve") {
      const ref = isRecord(params) && isRecord(params.data) ? params.data.ref : undefined;
      const data = typeof ref === "string" ? this.#completionData.get(ref) : undefined;
      if (data === undefined || !isRecord(params)) {
        if (id !== undefined) this.#reply(id, RPC.invalidParams, "知らない候補");
        return;
      }
      params = { ...params, data };
    } else {
      params = this.#paths.inward(params);
      if (params === DROP) {
        if (id !== undefined) this.#reply(id, RPC.invalidParams, "木の外を指す道");
        return;
      }
    }
    if (id !== undefined) this.#pending.set(JSON.stringify(id), method);
    this.#toTsc({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) });
  }

  /** 接続が切れた時に tsc を止める。2 回目からは何もしない */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    clearInterval(this.#rssTimer);
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#deps.tsc.kill("SIGKILL");
    this.#deps.onEnd?.();
  }

  /**
   * 画面との接続を閉じて止める
   * @param code WebSocket の閉じる code
   * @param reason 訳
   */
  #close(code: number, reason: string): void {
    if (this.#ended) return;
    this.#deps.close(code, reason);
    this.end();
  }

  /** 使われない時の待ちを始め直す */
  #armIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#close(1000, "使われていない"), LSP_IDLE_MS);
  }

  /**
   * 画面に誤りを返す
   * @param id 求めの id
   * @param code JSON-RPC の誤りの code
   * @param message 訳
   */
  #reply(id: number | string | null, code: number, message: string): void {
    this.#deps.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /**
   * tsc に 1 件送る
   * @param message JSON-RPC の 1 件
   */
  #toTsc(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message));
    this.#deps.tsc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]));
  }

  /**
   * tsc の stdout を LSP の枠 (Content-Length) ごとに切る
   * @param chunk 届いた物
   */
  #onTscData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#ended) return;
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.#buffer.byteLength > 1024) this.#close(1011, "tsc の返事の枠を読めない");
        return;
      }
      const length = Number(/^Content-Length: (\d+)$/im.exec(this.#buffer.subarray(0, end).toString("ascii"))?.[1] ?? "NaN");
      if (!Number.isSafeInteger(length)) {
        this.#close(1011, "tsc の返事の枠を読めない");
        return;
      }
      if (length > TSC_MESSAGE_BYTES) {
        this.#close(1011, "tsc の返事が大きすぎる");
        return;
      }
      if (this.#buffer.byteLength < end + 4 + length) return;
      const body = this.#buffer.subarray(end + 4, end + 4 + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(end + 4 + length);
      try {
        this.#fromTsc(JSON.parse(body));
      } catch {
        this.#close(1011, "tsc の返事を読めない");
      }
    }
  }

  /**
   * tsc から来た 1 件を、要求ならワークスペースが答え、返事と診断の知らせだけを道を画面に直して渡す
   * @param message JSON-RPC の 1 件
   */
  #fromTsc(message: unknown): void {
    if (!isRecord(message)) return;
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    if (typeof message.method === "string") {
      if (id !== undefined) {
        // 設定は既定のまま使わせる。ほかの要求 (登録、編集など) も画面に渡さずに受けたと返す
        const items = isRecord(message.params) && Array.isArray(message.params.items) ? message.params.items : null;
        this.#toTsc({ jsonrpc: "2.0", id, result: message.method === "workspace/configuration" && items !== null ? items.map(() => null) : null });
        return;
      }
      if (message.method !== "textDocument/publishDiagnostics") return;
      const params = this.#paths.outward(withoutMissing(message.params, "diagnostics"));
      if (params === DROP) return;
      hideOutside(params, "diagnostics");
      this.#deps.send(JSON.stringify({ jsonrpc: "2.0", method: message.method, params }));
      return;
    }
    if (id === undefined) return;
    const key = JSON.stringify(id);
    const method = this.#pending.get(key);
    // 画面が求めていない返事は渡さない
    if (method === undefined) return;
    this.#pending.delete(key);
    if (!("result" in message)) {
      this.#deps.send(JSON.stringify({ jsonrpc: "2.0", id, error: this.#paths.hideText(message.error) }));
      return;
    }
    let result: unknown = message.result;
    if (method === "textDocument/completion") result = this.#hideCompletionData(result);
    if (method === "completionItem/resolve") result = this.#hideCompletionData(result, false);
    if (method === "textDocument/diagnostic") result = withoutMissing(result, "items");
    const outward = this.#paths.outward(result);
    if (method === "textDocument/diagnostic") hideOutside(outward, "items");
    this.#deps.send(JSON.stringify({ jsonrpc: "2.0", id, result: outward === DROP ? null : outward }));
  }

  /**
   * 候補の data (tsc はワークスペースの道を入れる) を番号に替える。新しい候補の一覧では前の番号を捨てる
   * @param result 候補の一覧か、詳しい中身の 1 件
   * @param fresh 候補の一覧か
   * @returns 替えた物
   */
  #hideCompletionData(result: unknown, fresh = true): unknown {
    if (fresh) this.#completionData.clear();
    const hide = (item: unknown): unknown => {
      if (!isRecord(item) || item.data === undefined) return item;
      this.#completionSeq += 1;
      const ref = String(this.#completionSeq);
      this.#completionData.set(ref, item.data);
      return { ...item, data: { ref } };
    };
    if (Array.isArray(result)) return result.map(hide);
    if (!isRecord(result)) return result;
    if (!fresh) return hide(result);
    const items: unknown = result.items;
    return Array.isArray(items) ? { ...result, items: items.map(hide) } : result;
  }

}
