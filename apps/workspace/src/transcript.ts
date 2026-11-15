// SDK の会話の記録 (JSONL) の増えた分をゲートウェイに送り、落ちた後は社員 DO が戻した記録を SDK の置き場に書いて続きから送る (社員が考えるの 3.2、3.6)
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Fetcher, FETCH_TIMEOUT_MS, fromBase64, type RestoreInput, TRANSCRIPT_PART_BYTES } from "@know-office/core";
import { GATE_ORIGIN } from "./hooks.ts";

/** 会話の記録の続きを送るルート (POST /ws/v1/transcript-parts) */
export const GATE_TRANSCRIPT_URL = `${GATE_ORIGIN}ws/v1/transcript-parts`;

/** 行の終わり */
const NEWLINE = 0x0a;

/**
 * SDK が会話の記録を書く所を返す。SDK は <ホーム>/.claude/projects/<動く置き場の英数字のほかを - にした名前>/<session>.jsonl に書く
 * @param home SDK に渡すホーム
 * @param cwd SDK の動く置き場
 * @param sessionId SDK の session
 * @returns 会話の記録のファイル
 */
export function sessionFile(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** TranscriptShipper の依り所 */
export type ShipperDeps = {
  /** ゲートウェイを呼ぶ関数 */
  fetcher: Fetcher;
  /** SDK に渡すホーム */
  home: string;
  /** SDK の動く置き場 */
  cwd: string;
  /** 戻した記録の置き場とファイルを社員の持ち物にする。本番は staff に chown する。省くと変えない */
  own?: (path: string) => Promise<void>;
};

/** session ごとの、送り終えた所と次の通し番号 */
type Progress = { offset: number; seq: number };

/**
 * ファイルの、その位置から後ろを読む
 * @param file ファイル
 * @param offset 読み始める位置
 * @returns 読んだバイト列。ファイルが無ければ空
 */
async function readFrom(file: string, offset: number): Promise<Buffer> {
  const handle = await open(file, "r").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return Buffer.alloc(0);
  try {
    const { size } = await handle.stat();
    const out = Buffer.alloc(Math.max(0, size - offset));
    if (out.length > 0) await handle.read(out, 0, out.length, offset);
    return out;
  } finally {
    await handle.close();
  }
}

/** 会話の記録の増えた分を送る。送り終えた所を session ごとに覚え、送れなかった分は次に同じ通し番号で送り直す */
export class TranscriptShipper {
  // コンテナの Node は型を外すだけで走らせるので、引数のプロパティを使わない
  readonly #fetcher: Fetcher;
  readonly #home: string;
  readonly #cwd: string;
  readonly #own: (path: string) => Promise<void>;
  readonly #progress = new Map<string, Progress>();
  /** 送っている途中の物。同じ時に 2 度送らないよう、送りを 1 本ずつ流す */
  #chain: Promise<unknown> = Promise.resolve();

  /**
   * 送る口と、SDK の置き場を決める
   * @param deps ゲートウェイを呼ぶ関数、ホーム、動く置き場
   */
  constructor(deps: ShipperDeps) {
    this.#fetcher = deps.fetcher;
    this.#home = deps.home;
    this.#cwd = deps.cwd;
    this.#own = deps.own ?? (() => Promise.resolve());
  }

  /**
   * 社員 DO が復号した記録を SDK の置き場に書き、送り終えた所をその終わりにする
   * @param input RestoreInput
   * @returns 書き終わり
   */
  async restore(input: RestoreInput): Promise<void> {
    const bytes = fromBase64(input.transcript) ?? new Uint8Array();
    const file = sessionFile(this.#home, this.#cwd, input.sessionId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    // サーバーは root で書くので、続きを書く SDK (staff) が書けるよう、ホームの下の置き場とファイルを渡す
    const projects = join(this.#home, ".claude", "projects");
    for (const path of [join(this.#home, ".claude"), projects, dirname(file), file]) await this.#own(path);
    this.#progress.set(input.sessionId, { offset: bytes.byteLength, seq: input.nextSeq });
  }

  /**
   * session の記録の増えた分を、書き終えた行の終わりまで 512KiB ずつ送る
   * @param sessionId SDK の session
   * @param ticket 今の作業トークン
   * @returns 送り終わり
   * @throws Error ゲートウェイに届かないか、204 のほかを返した時
   */
  flush(sessionId: string, ticket: string): Promise<void> {
    const step = this.#chain.then(() => this.#flush(sessionId, ticket));
    this.#chain = step.catch(() => undefined);
    return step;
  }

  /**
   * 送る。flush() だけが 1 本ずつ呼ぶ
   * @param sessionId SDK の session
   * @param ticket 今の作業トークン
   */
  async #flush(sessionId: string, ticket: string): Promise<void> {
    const progress = this.#progress.get(sessionId) ?? { offset: 0, seq: 0 };
    const data = await readFrom(sessionFile(this.#home, this.#cwd, sessionId), progress.offset);
    // SDK が書きかけの行は、戻した時に読めない記録になるので、書き終えた行までを送る
    const end = data.lastIndexOf(NEWLINE) + 1;
    let { seq } = progress;
    let at = 0;
    while (at < end) {
      let stop = Math.min(end, at + TRANSCRIPT_PART_BYTES);
      if (stop < end) {
        const line = data.lastIndexOf(NEWLINE, stop - 1);
        // 1 行が 512KiB を超える時だけは行の途中で分ける。つなげば元に戻る
        if (line >= at) stop = line + 1;
      }
      await this.#send(sessionId, seq, data.subarray(at, stop), ticket);
      at = stop;
      seq += 1;
      // 送れた所までを覚え、送れなかった分は次に同じ通し番号で送り直す
      this.#progress.set(sessionId, { offset: progress.offset + at, seq });
    }
  }

  /**
   * 1 つの部分を送る
   * @param sessionId SDK の session
   * @param seq 通し番号
   * @param chunk 中身
   * @param ticket 今の作業トークン
   * @throws Error ゲートウェイに届かないか、204 のほかを返した時
   */
  async #send(sessionId: string, seq: number, chunk: Buffer, ticket: string): Promise<void> {
    const res = await this.#fetcher(GATE_TRANSCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ticket}` },
      body: JSON.stringify({ sessionId, seq, chunk: chunk.toString("base64") }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 中身と作業トークンは投げる文に入れない
    if (res.status !== 204) throw new Error(`会話の記録を送れない: ゲートウェイが ${String(res.status)} を返した`);
  }
}
