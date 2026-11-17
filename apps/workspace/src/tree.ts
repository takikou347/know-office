// エディタの補完に使うレビューの木を受け取り、確かめてから広げ、入れ替え、古い物を消す (社員が考えるの 2 章、仕事とレビューの 3.6)
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { AppError, type Clock, LSP_TREE_BYTES, type LspTreeParams } from "@know-office/core";

/** 木を置く所 */
export const REVIEW_ROOT = "/review";

/** 木の上限 */
export type TreeLimits = {
  /** 受ける圧縮した大きさ */
  gzBytes: number;
  /** 宣言した中身の大きさの合わせ */
  bytes: number;
  /** 件数 */
  entries: number;
  /** 広げた tar の流れの大きさ */
  streamBytes: number;
  /** 確かめと広げるのに使える時間 */
  ms: number;
  /** 置いておく木の数 */
  keep: number;
  /** 置いておく木の中身の大きさの合わせ */
  keepBytes: number;
};

/** 中身の上限 (300MiB) */
const TREE_BYTES = 300 * 1024 * 1024;
/** 件数の上限 */
const TREE_ENTRIES = 20_000;

/** 本番の上限。広げた流れは中身に、1 件ごとの枠と長い名前の分 (2KiB) と終わりの埋め草 (1MiB) を足した大きさまで */
export const TREE_LIMITS: TreeLimits = {
  gzBytes: LSP_TREE_BYTES,
  bytes: TREE_BYTES,
  entries: TREE_ENTRIES,
  streamBytes: TREE_BYTES + TREE_ENTRIES * 2048 + 1024 * 1024,
  ms: 60_000,
  keep: 3,
  keepBytes: 600 * 1024 * 1024,
};

/** 一時の置き場の名前の頭。木の名前 (UUID) と重ならない */
const TEMP_PREFIX = ".tmp-";

/** TreeStore の依り所 */
export type TreeDeps = {
  /** 木を置く所 */
  root: string;
  /** 木の node_modules からつなぐ型の束 */
  bundle: string;
  /** 今の時刻 */
  clock: Clock;
  /** 上限。省くと TREE_LIMITS */
  limits?: TreeLimits;
  /** tar の実行物。省くと /usr/bin/tar */
  tar?: string;
};

/**
 * 断る時の誤りを作る
 * @param message 訳
 * @returns 誤り
 */
function refused(message: string): AppError {
  return new AppError("validation_failed", message);
}

/** tar -tv の 1 行。種類、大きさ (デバイスは "major,minor")、日時の後ろの名前 */
const LIST_LINE = /^(.)\S{9}\s+\S+\s+(\d+(?:,\s*\d+)?)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? (.*)$/;

/**
 * tar -tv の一覧を確かめる。通常のファイルとフォルダのほか、.. と絶対の道、上限を超える物を断る
 * @param listing 一覧
 * @param limits 上限
 * @throws validation_failed 確かめに通らない時
 */
function checkListing(listing: string, limits: TreeLimits): void {
  const lines = listing.split("\n").filter((line) => line !== "");
  if (lines.length > limits.entries) throw refused("木の件数が多すぎる");
  let bytes = 0;
  for (const line of lines) {
    const match = LIST_LINE.exec(line);
    // 読めない行は断る側に倒す
    if (!match) throw refused("木の一覧を読めない");
    const [, type = "", size = "", name = ""] = match;
    if (type !== "-" && type !== "d") throw refused("通常のファイルとフォルダのほかを持つ木は受けない");
    if (name.startsWith("/") || name.split("/").includes("..")) throw refused("木の外を指す道を持つ木は受けない");
    bytes += Number(size);
    if (bytes > limits.bytes) throw refused("木が大きすぎる");
  }
}

/**
 * 決まった道から木の中身の大きさ (通常のファイルの合わせ) を数える。リンクは辿らない
 * @param dir 道
 * @returns バイト数
 */
function treeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += lstatSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

/**
 * 広げた物の持ち主の権限をそろえる。フォルダは 0755、ファイルは 0644 にし、実行の印と書き込みを外す
 * @param dir 道
 */
function normalizeModes(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) chmodSync(path, 0o755);
    else if (entry.isFile()) chmodSync(path, 0o644);
  }
  chmodSync(dir, 0o755);
}

/** ワークスペースが置くレビューの木。広げるのはワークスペースの中で 1 本ずつ */
export class TreeStore {
  /** 置き場、型の束、時刻、上限、tar */
  readonly deps: TreeDeps;
  /** 上限 */
  readonly limits: TreeLimits;
  readonly #tar: string;
  /** 使っている木の道と、使っている数 */
  readonly #held = new Map<string, number>();
  /** タスクごとの今の木のコミット。最後に入れた物 */
  readonly #current = new Map<string, string>();
  /** 1 本ずつ広げるための列 */
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * 木の置き場を作る
   * @param deps 置き場、型の束、時刻、上限、tar
   */
  constructor(deps: TreeDeps) {
    this.deps = deps;
    this.limits = deps.limits ?? TREE_LIMITS;
    this.#tar = deps.tar ?? "/usr/bin/tar";
  }

  /**
   * 受けた tar.gz を確かめて広げ、入れ替える。確かめに通らない時、時間を超えた時、欠けた gzip の時は、一時の物を消して前の木を残す
   * @param params 木の名前。確かめた物だけを渡す
   * @param body 本文
   * @throws payload_too_large 圧縮した大きさが上限を超える時
   * @throws validation_failed 木を確かめて断った時、時間を超えた時、gzip が欠けている時
   */
  async receive(params: LspTreeParams, body: AsyncIterable<Buffer>): Promise<void> {
    this.#ensureRoot();
    // 本文はサーバーだけが読める一時の置き場に数えながら書く
    const temp = join(this.deps.root, `${TEMP_PREFIX}${randomUUID()}`);
    mkdirSync(temp, { mode: 0o700 });
    try {
      const archive = join(temp, "tree.tar.gz");
      await this.#save(body, archive);
      const run = this.#queue.then(() => this.#install(params, archive, join(temp, "tree")));
      this.#queue = run.catch(() => undefined);
      await run;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  /**
   * タスクの今の木のコミットを返す。今の木は最後に入れた物
   * @param nodeId タスク。確かめた物だけを渡す
   * @returns コミット。無ければ null
   */
  current(nodeId: string): string | null {
    const sha = this.#current.get(nodeId);
    if (sha !== undefined && existsSync(join(this.deps.root, nodeId, sha))) return sha;
    // サーバーを起こし直した後は、最後に使った木を今の木とみる
    const dir = join(this.deps.root, nodeId);
    if (!existsSync(dir)) return null;
    const shas = readdirSync(dir).map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }));
    return shas.toSorted((a, b) => b.at - a.at)[0]?.name ?? null;
  }

  /**
   * 木の置き場を返す
   * @param params 木の名前。確かめた物だけを渡す
   * @returns 道
   */
  dir(params: LspTreeParams): string {
    return join(this.deps.root, params.nodeId, params.sha);
  }

  /**
   * 木を使っている印を付け、最後に使った時刻を今にする。使っている木は消さない
   * @param params 木の名前
   * @returns 印を外す関数。2 回目からは何もしない
   */
  hold(params: LspTreeParams): () => void {
    const dir = this.dir(params);
    this.#held.set(dir, (this.#held.get(dir) ?? 0) + 1);
    this.#touch(dir);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.#held.get(dir) ?? 1) - 1;
      if (count > 0) this.#held.set(dir, count);
      else this.#held.delete(dir);
    };
  }

  /** 置き場を root の 0755 で作る。lsp の利用者は読むだけ */
  #ensureRoot(): void {
    mkdirSync(this.deps.root, { recursive: true, mode: 0o755 });
    chmodSync(this.deps.root, 0o755);
  }

  /**
   * 最後に使った時刻を今にする
   * @param dir 木の道
   */
  #touch(dir: string): void {
    if (!existsSync(dir)) return;
    const now = new Date(this.deps.clock.now());
    utimesSync(dir, now, now);
  }

  /**
   * 本文を数えながら書く
   * @param body 本文
   * @param path 書く所
   * @throws payload_too_large 上限を超える時
   */
  async #save(body: AsyncIterable<Buffer>, path: string): Promise<void> {
    const out = createWriteStream(path, { mode: 0o600 });
    const failed = new Promise<never>((_resolve, reject) => out.once("error", reject));
    failed.catch(() => undefined);
    try {
      let total = 0;
      for await (const chunk of body) {
        total += chunk.byteLength;
        if (total > this.limits.gzBytes) throw new AppError("payload_too_large", "木の圧縮した大きさが上限を超える");
        if (!out.write(chunk)) await Promise.race([new Promise((resolve) => out.once("drain", resolve)), failed]);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
  }

  /**
   * tar.gz を確かめてから一時の所に広げ、入れ替える
   * @param params 木の名前
   * @param archive tar.gz
   * @param staging 広げる一時の所
   * @throws validation_failed 確かめに通らない時
   */
  async #install(params: LspTreeParams, archive: string, staging: string): Promise<void> {
    const deadline = this.deps.clock.now() + this.limits.ms;
    // 先に一覧で確かめ、通ってから広げる。-P で道を書いたまま出し、頭の / を消させない
    const listing = await this.#tarRun(["-t", "-v", "-P", "-f", "-"], archive, deadline, true);
    checkListing(listing, this.limits);
    mkdirSync(staging, { mode: 0o700 });
    await this.#tarRun(["-x", "-f", "-", "-C", staging, "--no-same-owner", "--no-same-permissions", "--strip-components=1", "--exclude=.git", "--exclude=node_modules"], archive, deadline, false);
    normalizeModes(staging);
    symlinkSync(this.deps.bundle, join(staging, "node_modules"));
    const target = this.dir(params);
    const nodeDir = join(this.deps.root, params.nodeId);
    mkdirSync(nodeDir, { recursive: true, mode: 0o755 });
    chmodSync(nodeDir, 0o755);
    // 同じ木がもうあれば中身は同じなので、新しい方を捨てる
    if (!existsSync(target)) renameSync(staging, target);
    this.#touch(target);
    this.#current.set(params.nodeId, params.sha);
    this.#evict(target);
  }

  /**
   * 同じタスクの前の木と、数と大きさの上限を超えた古い木を消す。使っている木と今入れた木は消さない
   * @param fresh 今入れた木
   */
  #evict(fresh: string): void {
    const trees: { dir: string; nodeId: string; at: number; bytes: number }[] = [];
    for (const nodeId of readdirSync(this.deps.root)) {
      if (nodeId.startsWith(TEMP_PREFIX)) continue;
      const nodeDir = join(this.deps.root, nodeId);
      for (const sha of readdirSync(nodeDir)) {
        const dir = join(nodeDir, sha);
        trees.push({ dir, nodeId, at: statSync(dir).mtimeMs, bytes: treeBytes(dir) });
      }
    }
    const freshNode = trees.find((tree) => tree.dir === fresh)?.nodeId;
    const kept = trees.filter((tree) => {
      const stale = tree.nodeId === freshNode && tree.dir !== fresh && !this.#held.has(tree.dir);
      if (stale) this.#remove(tree.dir);
      return !stale;
    });
    let bytes = kept.reduce((sum, tree) => sum + tree.bytes, 0);
    let count = kept.length;
    for (const tree of kept.toSorted((a, b) => a.at - b.at)) {
      if (count <= this.limits.keep && bytes <= this.limits.keepBytes) break;
      if (tree.dir === fresh || this.#held.has(tree.dir)) continue;
      this.#remove(tree.dir);
      count -= 1;
      bytes -= tree.bytes;
    }
  }

  /**
   * 木を消し、空になったタスクの置き場も消す
   * @param dir 木の道
   */
  #remove(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
    const nodeDir = join(dir, "..");
    if (readdirSync(nodeDir).length === 0) rmSync(nodeDir, { recursive: true, force: true });
  }

  /**
   * tar.gz を Node で数えながら広げて tar に流す。tar が先に終えても gzip は終わりまで数え、流れの上限と時間を超えたら tar を kill する
   * @param args tar の引数
   * @param archive tar.gz
   * @param deadline 期限の時刻
   * @param collect 出力を集めるか
   * @returns 集めた出力
   * @throws validation_failed 時間を超えた時、流れが上限を超えた時、gzip が欠けている時、tar が落ちた時
   */
  async #tarRun(args: string[], archive: string, deadline: number, collect: boolean): Promise<string> {
    const child = spawn(this.#tar, args, { stdio: ["pipe", "pipe", "ignore"], env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } });
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    let output = "";
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (!collect) return;
      outputBytes += chunk.byteLength;
      // 件数の上限の 1 行 1KiB を超える一覧は読まずに断る
      if (outputBytes > this.limits.entries * 1024 + 1024) child.kill("SIGKILL");
      else output += chunk.toString("utf8");
    });
    let stdinOpen = true;
    child.stdin.on("error", () => {
      stdinOpen = false;
    });
    const gunzip = createGunzip();
    const source = createReadStream(archive).pipe(gunzip);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
        source.destroy(refused("木を広げるのに時間が掛かりすぎた"));
      },
      Math.max(0, deadline - this.deps.clock.now()),
    );
    try {
      let streamed = 0;
      for await (const chunk of source as AsyncIterable<Buffer>) {
        streamed += chunk.byteLength;
        if (streamed > this.limits.streamBytes) {
          child.kill("SIGKILL");
          throw refused("木を広げた大きさが上限を超える");
        }
        if (stdinOpen && !child.stdin.write(chunk)) {
          await new Promise<void>((resolve) => {
            child.stdin.once("drain", resolve);
            child.stdin.once("error", resolve);
            child.stdin.once("close", resolve);
          });
        }
      }
      if (stdinOpen) child.stdin.end();
      const code = await exited;
      if (timedOut) throw refused("木を広げるのに時間が掛かりすぎた");
      if (code !== 0) throw refused("木を広げられない");
      return output;
    } catch (error) {
      child.kill("SIGKILL");
      await exited;
      if (error instanceof AppError) throw error;
      throw refused(timedOut ? "木を広げるのに時間が掛かりすぎた" : "木の gzip を読めない");
    } finally {
      clearTimeout(timer);
    }
  }
}
