// エディタの補完に使うレビューの木を、確かめてから広げ、断った時は前の木を残し、古い物から消す事を確かめる (仕事とレビューの 3.6)
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type Clock } from "@know-office/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TREE_LIMITS, type TreeLimits, TreeStore } from "../src/tree.ts";
import { type TarEntry, tarGz } from "./helpers/tar.ts";

const NODE = "0190f4a8-0000-7000-8000-000000000101";
const NODE_2 = "0190f4a8-0000-7000-8000-000000000102";
const NODE_3 = "0190f4a8-0000-7000-8000-000000000103";
const NODE_4 = "0190f4a8-0000-7000-8000-000000000104";
const SHA = "a".repeat(40);
const SHA_2 = "b".repeat(40);
/** GitHub の tarball の頭のフォルダ */
const TOP = "owner-repo-aaaaaaa";

/** 前に置いた木 */
const GOOD: TarEntry[] = [
  { name: `${TOP}/`, type: "dir" },
  { name: `${TOP}/src/`, type: "dir" },
  { name: `${TOP}/src/a.ts`, body: "export const a = 1;\n" },
];

/**
 * 本文を 1 つの塊で流す
 * @param body 中身
 * @yields 中身
 */
async function* once(body: Buffer): AsyncIterable<Buffer> {
  await Promise.resolve();
  yield body;
}

describe("レビューの木", () => {
  let base = "";
  let root = "";
  let bundle = "";
  let at = 1_700_000_000_000;
  const clock: Clock = { now: () => at };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ko-tree-"));
    root = join(base, "review");
    bundle = join(base, "bundle");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * 置き場を作る
   * @param limits 上書きする上限
   * @param tar tar の実行物
   * @returns 置き場
   */
  function store(limits: Partial<TreeLimits> = {}, tar?: string): TreeStore {
    return new TreeStore({ root, bundle, clock: { now: () => clock.now() }, limits: { ...TREE_LIMITS, ...limits }, ...(tar === undefined ? {} : { tar }) });
  }

  /**
   * 前の木を置いた上で新しい木を渡し、前の木が残り、一時の物が残らない事を確かめる
   * @param entries 断られる木
   * @param limits 上書きする上限
   * @param tail 終わりの印の後に足す 0 の長さ
   * @returns 断った誤りの code。受けたら "accepted"
   */
  async function rejectedKeepingPrevious(entries: TarEntry[], limits: Partial<TreeLimits> = {}, tail = 0): Promise<string> {
    const trees = store(limits);
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)));
    const code = await trees.receive({ nodeId: NODE, sha: SHA_2 }, once(tarGz(entries, tail))).then(
      () => "accepted",
      (error: unknown) => (error instanceof AppError ? error.code : "unknown"),
    );
    expect(trees.current(NODE)).toBe(SHA);
    expect(readFileSync(join(trees.dir({ nodeId: NODE, sha: SHA }), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readdirSync(root).toSorted()).toEqual([NODE]);
    expect(readdirSync(join(root, NODE))).toEqual([SHA]);
    return code;
  }

  it("広げた木は root の持ち物で、lsp は読むだけ", async () => {
    const trees = store();
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz([...GOOD, { name: `${TOP}/run.sh`, body: "#!/bin/sh\n" }])));
    const dir = trees.dir({ nodeId: NODE, sha: SHA });
    // 広げるのはサーバー (コンテナでは root) で、持ち主はサーバーの利用者になる。lsp の利用者の分けはイメージのテストで確かめる
    const uid = process.getuid?.() ?? -1;
    for (const [path, mode] of [
      [root, 0o755],
      [join(root, NODE), 0o755],
      [dir, 0o755],
      [join(dir, "src"), 0o755],
      [join(dir, "src/a.ts"), 0o644],
      [join(dir, "run.sh"), 0o644],
    ] as const) {
      const stat = lstatSync(path);
      expect({ path, uid: stat.uid, mode: stat.mode & 0o7777 }).toEqual({ path, uid, mode });
    }
    // 型の束は木の node_modules からつなぐ
    expect(readlinkSync(join(dir, "node_modules"))).toBe(bundle);
  });

  it("木は .git と node_modules を残さない", async () => {
    const trees = store();
    await trees.receive(
      { nodeId: NODE, sha: SHA },
      once(
        tarGz([
          ...GOOD,
          { name: `${TOP}/.git/`, type: "dir" },
          { name: `${TOP}/.git/config`, body: "[core]\n" },
          { name: `${TOP}/node_modules/`, type: "dir" },
          { name: `${TOP}/node_modules/x/index.d.ts`, body: "export {};\n" },
          { name: `${TOP}/pkg/node_modules/y.d.ts`, body: "export {};\n" },
          { name: `${TOP}/.gitignore`, body: "dist\n" },
        ]),
      ),
    );
    const dir = trees.dir({ nodeId: NODE, sha: SHA });
    expect(readdirSync(dir).toSorted()).toEqual([".gitignore", "node_modules", "src"]);
    // 木の node_modules は型の束へのリンクだけ
    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "pkg"))).toBe(false);
  });

  it("シンボリックリンクを持つ木は確かめの段で断り、前の木を残す", async () => {
    expect(await rejectedKeepingPrevious([...GOOD, { name: `${TOP}/passwd`, type: "symlink", link: "/etc/passwd" }])).toBe("validation_failed");
  });

  it("ハードリンクを持つ木は確かめの段で断り、前の木を残す", async () => {
    expect(await rejectedKeepingPrevious([...GOOD, { name: `${TOP}/b.ts`, type: "hardlink", link: `${TOP}/src/a.ts` }])).toBe("validation_failed");
  });

  it("デバイスと fifo を持つ木は確かめの段で断り、前の木を残す", async () => {
    for (const type of ["char", "block", "fifo"] as const) {
      rmSync(root, { recursive: true, force: true });
      expect(await rejectedKeepingPrevious([...GOOD, { name: `${TOP}/dev`, type }])).toBe("validation_failed");
    }
  });

  it("道に .. か絶対の道を持つ木は断り、前の木を残す", async () => {
    for (const name of [`${TOP}/../../evil.ts`, `${TOP}/src/../../evil.ts`, "/etc/evil.ts", ".."]) {
      rmSync(root, { recursive: true, force: true });
      expect(await rejectedKeepingPrevious([...GOOD, { name, body: "x" }])).toBe("validation_failed");
    }
  });

  it("宣言の大きさが 300MiB か件数が 20,000 件を超える木は断り、前の木を残す", async () => {
    expect({ bytes: TREE_LIMITS.bytes, entries: TREE_LIMITS.entries }).toEqual({ bytes: 300 * 1024 * 1024, entries: 20_000 });
    // 上限ちょうどは通す。GOOD は 3 件、20 バイト
    const exact = store({ bytes: 20 + 5, entries: 4 });
    await exact.receive({ nodeId: NODE_2, sha: SHA }, once(tarGz([...GOOD, { name: `${TOP}/b.ts`, body: "12345" }])));
    expect(exact.current(NODE_2)).toBe(SHA);
    rmSync(root, { recursive: true, force: true });
    // 大きさを 1 バイト超える。中身は 0 で埋めて宣言だけを大きくする
    expect(await rejectedKeepingPrevious([...GOOD, { name: `${TOP}/b.ts`, size: 6 }], { bytes: 20 + 5, entries: 4 })).toBe("validation_failed");
    rmSync(root, { recursive: true, force: true });
    // 件数を 1 つ超える
    expect(await rejectedKeepingPrevious([...GOOD, { name: `${TOP}/b.ts`, body: "1" }, { name: `${TOP}/c.ts`, body: "1" }], { bytes: 20 + 5, entries: 4 })).toBe("validation_failed");
  });

  it("宣言より大きく広がる gzip 爆弾は、広げながら 300MiB を数えて止め、前の木を残す", async () => {
    // 宣言は小さいまま、終わりの印の後ろに 0 を続けて、広げた流れだけを大きくする
    expect(await rejectedKeepingPrevious(GOOD, { streamBytes: 64 * 1024 }, 1024 * 1024)).toBe("validation_failed");
  });

  it("広げるのが 60 秒を超えたら kill し、前の木を残す", async () => {
    expect(TREE_LIMITS.ms).toBe(60_000);
    // 広げる段だけ遅い tar の代わり。確かめの段は本物に任せる
    const slow = join(base, "slow-tar");
    writeFileSync(slow, `#!/bin/sh\ncase " $* " in *" -x"*) exec sleep 30 ;; esac\nexec tar "$@"\n`);
    chmodSync(slow, 0o755);
    const trees = store({ ms: 300 });
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)));
    const slowTrees = store({ ms: 300 }, slow);
    const started = Date.now();
    await expect(slowTrees.receive({ nodeId: NODE, sha: SHA_2 }, once(tarGz(GOOD)))).rejects.toMatchObject({ code: "validation_failed" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(slowTrees.current(NODE)).toBe(SHA);
    expect(readdirSync(root)).toEqual([NODE]);
    expect(readdirSync(join(root, NODE))).toEqual([SHA]);
  });

  it("欠けた gzip は断り、前の木を残す", async () => {
    const trees = store();
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)));
    const broken = tarGz([...GOOD, { name: `${TOP}/b.ts`, body: "x".repeat(4096) }]);
    await expect(trees.receive({ nodeId: NODE, sha: SHA_2 }, once(broken.subarray(0, broken.byteLength - 20)))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(trees.receive({ nodeId: NODE, sha: SHA_2 }, once(Buffer.from("not gzip")))).rejects.toMatchObject({ code: "validation_failed" });
    expect(trees.current(NODE)).toBe(SHA);
    expect(readdirSync(root)).toEqual([NODE]);
  });

  it("受ける圧縮した大きさが 50MiB を超えたら読むのを止めて断る", async () => {
    expect(TREE_LIMITS.gzBytes).toBe(50 * 1024 * 1024);
    const body = tarGz(GOOD);
    const exact = store({ gzBytes: body.byteLength });
    await exact.receive({ nodeId: NODE, sha: SHA }, once(body));
    const over = store({ gzBytes: body.byteLength - 1 });
    await expect(over.receive({ nodeId: NODE, sha: SHA_2 }, once(body))).rejects.toMatchObject({ code: "payload_too_large" });
    expect(over.current(NODE)).toBe(SHA);
    expect(readdirSync(root)).toEqual([NODE]);
  });

  it("同じ木を同時に 2 回受けても、広げるのは 1 本ずつで、最後に残るのは 1 つ", async () => {
    // 広げる段の始まりと終わりを書き残す tar の代わり
    const log = join(base, "tar.log");
    const logging = join(base, "logging-tar");
    writeFileSync(logging, `#!/bin/sh\ncase " $* " in *" -x"*) echo start >> ${log}; sleep 0.2; tar "$@"; code=$?; echo end >> ${log}; exit $code ;; esac\nexec tar "$@"\n`);
    chmodSync(logging, 0o755);
    const trees = store({}, logging);
    await Promise.all([trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD))), trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)))]);
    expect(readFileSync(log, "utf8")).toBe("start\nend\nstart\nend\n");
    expect(readdirSync(root)).toEqual([NODE]);
    expect(readdirSync(join(root, NODE))).toEqual([SHA]);
    expect(trees.current(NODE)).toBe(SHA);
  });

  it("新しい先の木を受けたら、同じタスクの前の木は使っていなければ消す", async () => {
    const trees = store();
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)));
    at += 1_000;
    await trees.receive({ nodeId: NODE, sha: SHA_2 }, once(tarGz(GOOD)));
    expect(readdirSync(join(root, NODE))).toEqual([SHA_2]);
    expect(trees.current(NODE)).toBe(SHA_2);
    // 使っている前の木は残し、今の木は新しい方
    const release = trees.hold({ nodeId: NODE, sha: SHA_2 });
    at += 1_000;
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)));
    expect(readdirSync(join(root, NODE)).toSorted()).toEqual([SHA, SHA_2]);
    expect(trees.current(NODE)).toBe(SHA);
    release();
  });

  it("木は 3 本、600MiB を超えたら古い物から消し、使っている木は消さない", async () => {
    expect({ keep: TREE_LIMITS.keep, keepBytes: TREE_LIMITS.keepBytes }).toEqual({ keep: 3, keepBytes: 600 * 1024 * 1024 });
    const trees = store();
    at += 1_000;
    await trees.receive({ nodeId: NODE, sha: SHA }, once(tarGz(GOOD)));
    // いちばん古い NODE は使っているので、次に古い NODE_2 を消す
    const release = trees.hold({ nodeId: NODE, sha: SHA });
    for (const nodeId of [NODE_2, NODE_3]) {
      at += 1_000;
      await trees.receive({ nodeId, sha: SHA }, once(tarGz(GOOD)));
    }
    at += 1_000;
    await trees.receive({ nodeId: NODE_4, sha: SHA }, once(tarGz(GOOD)));
    expect(readdirSync(root).toSorted()).toEqual([NODE, NODE_3, NODE_4]);
    release();
    // 大きさの合わせ: 中身の合わせを 140 バイトまでにすると、120 バイトの木を入れた後に 20 バイトの木を 2 本残せず、古い物から消す
    const small = store({ keepBytes: 120 + 20 });
    at += 1_000;
    const big = [...GOOD.slice(0, 1), { name: `${TOP}/big.ts`, body: "x".repeat(120 - 20) }, ...GOOD.slice(1)];
    await small.receive({ nodeId: NODE_2, sha: SHA }, once(tarGz(big)));
    expect(readdirSync(root).toSorted()).toEqual([NODE_2, NODE_4]);
  });
});
