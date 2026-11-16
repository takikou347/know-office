// SDK の会話の記録 (JSONL) の増えた分をゲートウェイに送り、落ちた後は社員 DO が戻した記録を SDK の置き場に書いて続きから送る (社員が考えるの 3.3、3.7)
import { existsSync, type Stats } from "node:fs";
import { constants, type FileHandle, mkdir, open } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
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

/** 置き場とファイルの持ち主にする社員。本番は staff */
export type Owner = {
  /** 社員の uid */
  uid: number;
  /** 社員の gid */
  gid: number;
};

/** TranscriptShipper の依り所 */
export type ShipperDeps = {
  /** ゲートウェイを呼ぶ関数 */
  fetcher: Fetcher;
  /** SDK に渡すホーム */
  home: string;
  /** SDK の動く置き場 */
  cwd: string;
  /** 置き場とファイルの持ち主。渡すと、社員かサーバーの持ち物だけを触り、戻した物を社員に渡す。省くと持ち主を見ない */
  owner?: Owner;
};

/** session ごとの、送り終えた所と次の通し番号 */
type Progress = { offset: number; seq: number };

/** 開いたディレクトリ。path は /proc の無い機械で次の段を開くための道 */
type Dir = { handle: FileHandle; path: string };

/** Linux は開いたディレクトリの fd の下の名前を開ける。途中の段を後から symlink にすり替えられても追わない */
const FD_ROOT = "/proc/self/fd";

/** 社員が置いた symlink、FIFO、ほかの持ち主の物を断る時の文。中身と道は入れない */
const REFUSED = "会話の記録の置き場が、社員の通常のディレクトリとファイルでない";

/**
 * 開いたディレクトリの下の名前を指す道を返す
 * @param dir 開いたディレクトリ
 * @param name 下の名前
 * @returns 開く道
 */
function under(dir: Dir, name: string): string {
  return existsSync(FD_ROOT) ? `${FD_ROOT}/${String(dir.handle.fd)}/${name}` : join(dir.path, name);
}

/**
 * 失敗の code を返す
 * @param error 投げられた物
 * @returns code。無ければ空
 */
function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
}

/**
 * 持ち主が社員かサーバーかを確かめる。サーバーの物 (root が作った物) は社員が書き換えられない
 * @param stat 開いた物
 * @param owner 社員。無ければ見ない
 * @throws Error ほかの持ち主の時
 */
function checkOwner(stat: Stats, owner: Owner | undefined): void {
  if (owner && stat.uid !== owner.uid && stat.uid !== process.getuid?.()) throw new Error(REFUSED);
}

/**
 * ディレクトリを symlink を追わずに開き、通常のディレクトリで、持ち主が社員かサーバーである事を確かめる
 * @param path 開く道
 * @param real 次の段を開くための道
 * @param owner 社員。無ければ持ち主を見ない
 * @returns 開いたディレクトリ。無ければ null
 * @throws Error symlink、ディレクトリでない、ほかの持ち主の時
 */
async function openDir(path: string, real: string, owner: Owner | undefined): Promise<Dir | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw new Error(REFUSED, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error(REFUSED);
    checkOwner(stat, owner);
    return { handle, path: real };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * ホームから会話の記録の置き場まで、1 段ずつ symlink を追わずに開いて下りる。ホームは社員が差し替えられない所にある前提
 * @param file 会話の記録のファイル
 * @param home ホーム
 * @param owner 社員
 * @param create 無い段を作るか。作った段とサーバーの持ち物の段は社員に渡す
 * @returns 置き場のディレクトリ。create でなく、途中の段が無ければ null
 * @throws Error 途中の段が symlink、ディレクトリでない、ほかの持ち主の時
 */
async function descend(file: string, home: string, owner: Owner | undefined, create: boolean): Promise<Dir | null> {
  const top = await openDir(home, home, undefined);
  if (!top) throw new Error(REFUSED);
  let dir = top;
  for (const name of relative(home, dirname(file)).split(sep)) {
    const path = under(dir, name);
    let next: Dir | null;
    try {
      if (create) await mkdir(path).catch((error: unknown) => (codeOf(error) === "EEXIST" ? undefined : Promise.reject(new Error(REFUSED, { cause: error }))));
      next = await openDir(path, join(dir.path, name), owner);
      if (next && create && owner) await next.handle.chown(owner.uid, owner.gid);
    } finally {
      await dir.handle.close();
    }
    if (!next) return null;
    dir = next;
  }
  return dir;
}

/**
 * 会話の記録のファイルを、symlink を追わず、FIFO で待たずに開き、リンクが 1 つの通常のファイルで、持ち主が社員かサーバーである事を確かめる
 * @param dir 置き場のディレクトリ
 * @param name ファイルの名前
 * @param flags 開き方
 * @param owner 社員
 * @returns 開いたファイル。無ければ null
 * @throws Error symlink、FIFO、ディレクトリ、ハードリンク、ほかの持ち主の時
 */
async function openFile(dir: Dir, name: string, flags: number, owner: Owner | undefined): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(under(dir, name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw new Error(REFUSED, { cause: error });
  }
  try {
    const stat = await handle.stat();
    // ハードリンクは、社員が読めない、書けないファイルに同じ名前を付けた物かもしれない
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(REFUSED);
    checkOwner(stat, owner);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * 会話の記録のファイルの、その位置から後ろを読む
 * @param file ファイル
 * @param home ホーム
 * @param owner 社員
 * @param offset 読み始める位置
 * @returns 読んだバイト列。ファイルが無ければ空
 * @throws Error 置き場かファイルが、社員の通常のディレクトリとファイルでない時
 */
async function readFrom(file: string, home: string, owner: Owner | undefined, offset: number): Promise<Buffer> {
  const dir = await descend(file, home, owner, false);
  if (!dir) return Buffer.alloc(0);
  try {
    const handle = await openFile(dir, basename(file), constants.O_RDONLY, owner);
    if (!handle) return Buffer.alloc(0);
    try {
      const { size } = await handle.stat();
      const out = Buffer.alloc(Math.max(0, size - offset));
      if (out.length > 0) await handle.read(out, 0, out.length, offset);
      return out;
    } finally {
      await handle.close();
    }
  } finally {
    await dir.handle.close();
  }
}

/**
 * 会話の記録のファイルを中身で置き換え、社員に渡す
 * @param file ファイル
 * @param home ホーム
 * @param owner 社員
 * @param bytes 中身
 * @throws Error 置き場かファイルが、社員の通常のディレクトリとファイルでない時
 */
async function replace(file: string, home: string, owner: Owner | undefined, bytes: Uint8Array): Promise<void> {
  const dir = await descend(file, home, owner, true);
  if (!dir) throw new Error(REFUSED);
  try {
    // 開いた物を確かめるまで中身を消さない。O_TRUNC は付けない
    const handle = await openFile(dir, basename(file), constants.O_WRONLY | constants.O_CREAT, owner);
    if (!handle) throw new Error(REFUSED);
    try {
      await handle.truncate(0);
      await handle.writeFile(bytes);
      if (owner) await handle.chown(owner.uid, owner.gid);
    } finally {
      await handle.close();
    }
  } finally {
    await dir.handle.close();
  }
}

/** 会話の記録の増えた分を送る。送り終えた所を session ごとに覚え、送れなかった分は次に同じ通し番号で送り直す */
export class TranscriptShipper {
  // コンテナの Node は型を外すだけで走らせるので、引数のプロパティを使わない
  readonly #fetcher: Fetcher;
  readonly #home: string;
  readonly #cwd: string;
  readonly #owner: Owner | undefined;
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
    this.#owner = deps.owner;
  }

  /**
   * 社員 DO が復号した記録を SDK の置き場に書き、送り終えた所をその終わりにする
   * @param input RestoreInput
   * @returns 書き終わり
   * @throws Error 置き場かファイルが、社員の通常のディレクトリとファイルでない時
   */
  async restore(input: RestoreInput): Promise<void> {
    const bytes = fromBase64(input.transcript) ?? new Uint8Array();
    const file = sessionFile(this.#home, this.#cwd, input.sessionId);
    // サーバーは root で、置き場は社員が書ける。社員が置いた symlink や FIFO を追って、ほかのファイルを書き換えたり渡したりしない
    await replace(file, this.#home, this.#owner, bytes);
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
    const data = await readFrom(sessionFile(this.#home, this.#cwd, sessionId), this.#home, this.#owner, progress.offset);
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
