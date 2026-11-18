// レビューのエディタの補完の口 (GET /api/v1/reviews/{nodeId}/lsp)。初めて書き換えた時か候補を求めた時に開き、tsc の JSON-RPC をエディタの候補と下線と説明に直す (タスクとレビューの 3.2)
import type { EditorCompletion, EditorDiagnostic } from "knowidea-ui/editor";
import { type Clock, systemClock } from "@know-office/core";
import { z } from "zod";
import type { Api } from "../../api.ts";

/** 補完の WebSocket の口。画面ではブラウザーの WebSocket、テストは代わりの物 */
export type LspSocket = {
  /** つながった、文が届いた、切れた時に呼ぶ関数を足す */
  addEventListener(type: "open" | "close" | "message", listener: (e: { data?: unknown }) => void): void;
  /** 文を送る */
  send(data: string): void;
  /** 閉じる */
  close(): void;
};

/** 補完の口の作り方 */
export type LspDeps = {
  /** 配信の作業トークンを出させる。出せなければ null */
  ticket: () => Promise<string | null>;
  /** 作業トークンで WebSocket を開く */
  open: (ticket: string) => LspSocket;
};

/** エディタの中の場所。line と column は 1 から */
export type LspPlace = { line: number; column: number; text: string };

/** 1 つのファイルの補完の口 */
export type ReviewLsp = {
  /** 中身を送って診断を求める。つなげない時と、答えの前に中身が変わった時は null */
  diagnose(text: string): Promise<EditorDiagnostic[] | null>;
  /** 中身を送って候補を求める。つなげない時は null */
  complete(place: LspPlace): Promise<EditorCompletion[] | null>;
  /** 型と説明を求める。まだつないでいない時は開かずに null */
  hover(place: LspPlace): Promise<string | null>;
  /** 開いている接続を閉じる。後でまた求めれば開き直す */
  close(): void;
};

/** tsc がつなぐファイル */
const LANGUAGES: [RegExp, string][] = [
  [/\.[cm]?tsx$/, "typescriptreact"],
  [/\.[cm]?ts$/, "typescript"],
  [/\.[cm]?jsx$/, "javascriptreact"],
  [/\.[cm]?js$/, "javascript"],
];

/** つないだ後に閉じられて開き直すのは、この長さの間に REOPEN_LIMIT 回まで。2 つのタブで同じレビューを直すと 1008 で閉じ合うので、開き直し続けない */
const REOPEN_WINDOW_MS = 60_000;
const REOPEN_LIMIT = 3;

/** 答えを待つ長さ。ワークスペースを起こして木を広げるまで待つ */
const ANSWER_TIMEOUT_MS = 60_000;

// LSP 3.17 の CompletionItemKind を、エディタの印の種類に直す
const KINDS: Record<number, string> = { 1: "text", 2: "method", 3: "function", 4: "function", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace", 10: "property", 13: "enum", 14: "keyword", 20: "constant", 21: "constant", 22: "class", 25: "type" };
// LSP 3.17 の DiagnosticSeverity。1 は誤り、2 は注意、ほかは知らせ
const SEVERITIES: Record<number, EditorDiagnostic["severity"]> = { 1: "error", 2: "warning" };
// LSP 3.17 の InsertTextFormat。2 は雛形 (snippet) で、$1 などの印を持つ
const SNIPPET = 2;

const Answer = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).loose();
const Position = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const CompletionItem = z
  .object({ label: z.string(), kind: z.number().optional(), detail: z.string().optional(), insertText: z.string().optional(), insertTextFormat: z.number().optional(), textEdit: z.object({ newText: z.string() }).loose().optional() })
  .loose();
const Completions = z.union([z.array(CompletionItem), z.object({ items: z.array(CompletionItem) }).loose().transform((r) => r.items)]);
const Diagnostics = z
  .object({ items: z.array(z.object({ range: z.object({ start: Position, end: Position }), severity: z.number().optional(), message: z.string() }).loose()) })
  .loose()
  .transform((r) => r.items);
const Marked = z.union([z.string(), z.object({ value: z.string() }).loose().transform((m) => m.value)]);
const Hover = z.object({ contents: z.union([Marked, z.array(Marked)]) }).loose();

/** 開いた 1 本の接続 */
type Conn = { socket: LspSocket; request: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => void; text: string; version: number };

/**
 * 候補を 1 つ、エディタの形に直す
 * @param item tsc の候補
 * @returns エディタの候補
 */
function toCompletion(item: z.infer<typeof CompletionItem>): EditorCompletion {
  const text = item.insertTextFormat === SNIPPET ? undefined : (item.textEdit?.newText ?? item.insertText);
  const kind = item.kind === undefined ? undefined : KINDS[item.kind];
  return {
    label: item.label,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(kind === undefined ? {} : { type: kind }),
    // 省ける引数の印 (?) は入れる文字に付けない
    apply: text ?? item.label.replace(/\?$/, ""),
  };
}

/**
 * 説明の文から、コードの囲みの行 (逆引用符 3 つで始まる行) を外す
 * @param text Markdown の説明
 * @returns 囲みを外した文
 */
function plain(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("```"))
    .join("\n")
    .trim();
}

/**
 * 1 つのファイルの補完の口を作る。初めて diagnose か complete を呼んだ時に開き、つなげなければこのエディタではもうつながない
 * @param deps 作業トークンと WebSocket の口
 * @param path 木の中のファイルの道
 * @param clock 閉じられた時刻を数える時計
 * @returns 補完の口
 */
export function reviewLsp(deps: LspDeps, path: string, clock: Pick<Clock, "now"> = systemClock): ReviewLsp {
  const languageId = LANGUAGES.find(([pattern]) => pattern.test(path))?.[1];
  const uri = `file:///repo/${path.split("/").map(encodeURIComponent).join("/")}`;
  // epoch は close のたびに進め、閉じる前に開き始めた接続を閉じた後に残さない
  const state: { conn: Promise<Conn | null> | null; failed: boolean; epoch: number; dropped: number[] } = { conn: null, failed: languageId === undefined, epoch: 0, dropped: [] };

  /**
   * つないだ後にサーバーに閉じられた時刻を数え、1 分に 3 回を超えたら開き直さない
   */
  const dropped = (): void => {
    const now = clock.now();
    state.dropped = [...state.dropped.filter((at) => at > now - REOPEN_WINDOW_MS), now];
    if (state.dropped.length > REOPEN_LIMIT) state.failed = true;
  };

  /**
   * 作業トークンを出させて開き、初期化してからファイルを開く
   * @param text 今の中身
   * @param epoch 開き始めた時の close の回数
   * @returns 接続。つなげない時と、開く間に閉じられた時は null
   */
  const connect = async (text: string, epoch: number): Promise<Conn | null> => {
    const ticket = await deps.ticket().catch(() => null);
    if (ticket === null || epoch !== state.epoch) return null;
    const socket = deps.open(ticket);
    const waiting = new Map<number, (result: unknown) => void>();
    let next = 0;
    let live = false;
    let established = false;
    const opened = new Promise<boolean>((resolve) => {
      socket.addEventListener("open", () => {
        live = true;
        resolve(true);
      });
      socket.addEventListener("close", () => {
        live = false;
        if (epoch === state.epoch) {
          state.conn = null;
          if (established) dropped();
        }
        for (const done of waiting.values()) done(undefined);
        waiting.clear();
        resolve(false);
      });
    });
    socket.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const answer = Answer.safeParse(raw);
      if (!answer.success) return;
      const done = waiting.get(answer.data.id);
      waiting.delete(answer.data.id);
      done?.(answer.data.error === undefined ? answer.data.result : undefined);
    });
    const conn: Conn = {
      socket,
      text,
      version: 1,
      notify: (method, params) => {
        if (live) socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      },
      request: (method, params) => {
        if (!live) return Promise.resolve(undefined);
        next += 1;
        const id = next;
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiting.delete(id);
            resolve(undefined);
          }, ANSWER_TIMEOUT_MS);
          waiting.set(id, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
      },
    };
    if (!(await opened)) return null;
    // 道と力はワークスペースが決めた値に作り直すので、画面は最小の形だけを送る
    const init = await conn.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    if (init === undefined || !live || epoch !== state.epoch) {
      socket.close();
      return null;
    }
    conn.notify("initialized", {});
    conn.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: conn.version, text } });
    established = true;
    return conn;
  };

  /**
   * つないで、中身をそろえる。まだつないでいなければ開く
   * @param text 今の中身
   * @returns 接続。つなげなければ null
   */
  const ready = async (text: string): Promise<Conn | null> => {
    if (state.failed) return null;
    if (state.conn === null) {
      const epoch = state.epoch;
      const made = connect(text, epoch);
      state.conn = made;
      const conn = await made;
      // つなげなかった時は、このエディタでつなぎ直さない (503 や上限の時に作業トークンを出し続けない)。閉じられた時は次の求めで開き直す
      if (conn === null) {
        if (epoch === state.epoch) state.failed = true;
        if (state.conn === made) state.conn = null;
      }
      return conn;
    }
    const conn = await state.conn;
    if (conn === null) return null;
    if (conn.text !== text) {
      conn.version += 1;
      conn.text = text;
      conn.notify("textDocument/didChange", { textDocument: { uri, version: conn.version }, contentChanges: [{ text }] });
    }
    return conn;
  };

  const at = (place: LspPlace) => ({ textDocument: { uri }, position: { line: place.line - 1, character: place.column - 1 } });

  return {
    diagnose: async (text) => {
      const conn = await ready(text);
      if (!conn) return null;
      const found = Diagnostics.safeParse(await conn.request("textDocument/diagnostic", { textDocument: { uri } }));
      // 答えの前に書き換えた時は、次の診断に任せる
      if (!found.success || conn.text !== text) return null;
      return found.data.map((d) => ({
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        severity: SEVERITIES[d.severity ?? 3] ?? "info",
        message: d.message,
      }));
    },
    complete: async (place) => {
      const conn = await ready(place.text);
      if (!conn) return null;
      const found = Completions.safeParse(await conn.request("textDocument/completion", at(place)));
      return found.success ? found.data.map(toCompletion) : null;
    },
    hover: async (place) => {
      // 合わせただけで開かない。読むだけの時はつながない
      if (state.conn === null) return null;
      const conn = await ready(place.text);
      if (!conn) return null;
      const found = Hover.safeParse(await conn.request("textDocument/hover", at(place)));
      if (!found.success) return null;
      const parts = Array.isArray(found.data.contents) ? found.data.contents : [found.data.contents];
      const text = parts.map(plain).filter((p) => p !== "").join("\n");
      return text === "" ? null : text;
    },
    close: () => {
      state.epoch += 1;
      const open = state.conn;
      state.conn = null;
      void open?.then((conn) => conn?.socket.close());
    },
  };
}

const TicketReply = z.object({ data: z.object({ ticket: z.string() }).loose() }).loose();

/**
 * ブラウザーでレビューの補完の口を開く口を作る
 * @param api 入口を呼ぶ口
 * @param nodeId レビューするタスク
 * @returns 補完の口の作り方
 */
export function browserLsp(api: Api, nodeId: string): LspDeps {
  return {
    ticket: async () => {
      const res = await api.api.v1.live.tickets.$post();
      if (!res.ok) return null;
      return TicketReply.parse(await res.json()).data.ticket;
    },
    open: (ticket) => {
      const url = api.api.v1.reviews[":nodeId"].lsp.$url({ param: { nodeId }, query: { ticket } });
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url);
    },
  };
}
