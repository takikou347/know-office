// ワークスペースが SDK の会話の記録 (JSONL) の増えた分をゲートウェイに送り、落ちた後は戻した記録の続きから送る事を確かめる (社員が考えるの 3.3、3.7)
import { execFileSync } from "node:child_process";
import { appendFileSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Fetcher, TRANSCRIPT_PART_BYTES, TranscriptPartInput } from "@know-office/core";
import { afterEach, describe, expect, it } from "vitest";
import { sessionFile, TranscriptShipper } from "../src/transcript.ts";

const SESSION = "0190f4a8-0000-7000-8000-00000000c001";
const WORK = "/work";

/** ゲートウェイが受けた部分 */
type Sent = { url: string; auth: string | null; seq: number; text: string };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 空のホームを作る。テストの後に消す
 * @returns ホームの道
 */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "ko-transcript-"));
  dirs.push(dir);
  return dir;
}

/**
 * 受けた部分を並べ、決めた答えを返すゲートウェイの代わりを作る
 * @param status 返すステータス
 * @returns fetch の代わりと受けた部分
 */
function gate(status = 204): { fetcher: Fetcher; sent: Sent[]; answer: { status: number } } {
  const sent: Sent[] = [];
  const answer = { status };
  const fetcher: Fetcher = (url, init) => {
    // 送った形がゲートウェイの入力に合うかも見る
    const body = TranscriptPartInput.parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    if (answer.status === 204) sent.push({ url, auth: new Headers(init?.headers).get("authorization"), seq: body.seq, text: Buffer.from(body.chunk, "base64").toString("utf8") });
    return Promise.resolve(new Response(null, { status: answer.status }));
  };
  return { fetcher, sent, answer };
}

/**
 * SDK が書く会話の記録に行を足す
 * @param dir ホーム
 * @param text 足す文字
 */
function write(dir: string, text: string): void {
  const file = sessionFile(dir, WORK, SESSION);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

describe("会話の記録を送る", () => {
  it("SDK が書いた記録の増えた分を、行の終わりまで通し番号を付けて作業トークンで送る", async () => {
    const dir = home();
    const { fetcher, sent } = gate();
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK });
    write(dir, '{"n":1}\n{"n":2}\n');
    await shipper.flush(SESSION, "ticket-1");
    // 書きかけの行は、書き終わるまで送らない
    write(dir, '{"n":3}\n{"n":');
    await shipper.flush(SESSION, "ticket-2");
    await shipper.flush(SESSION, "ticket-2");
    write(dir, "4}\n");
    await shipper.flush(SESSION, "ticket-2");
    expect(sent).toEqual([
      { url: "http://gate.internal/ws/v1/transcript-parts", auth: "Bearer ticket-1", seq: 0, text: '{"n":1}\n{"n":2}\n' },
      { url: "http://gate.internal/ws/v1/transcript-parts", auth: "Bearer ticket-2", seq: 1, text: '{"n":3}\n' },
      { url: "http://gate.internal/ws/v1/transcript-parts", auth: "Bearer ticket-2", seq: 2, text: '{"n":4}\n' },
    ]);
  });

  it("512KiB を超える増えは、行の終わりで分けて送る", async () => {
    const dir = home();
    const { fetcher, sent } = gate();
    const line = `${"a".repeat(1023)}\n`;
    write(dir, line.repeat(TRANSCRIPT_PART_BYTES / 1024 + 10));
    await new TranscriptShipper({ fetcher, home: dir, cwd: WORK }).flush(SESSION, "ticket-1");
    expect(sent.map((s) => [s.seq, Buffer.byteLength(s.text)])).toEqual([
      [0, TRANSCRIPT_PART_BYTES],
      [1, 10 * 1024],
    ]);
  });

  it("送れなければ投げ、次は同じ所から同じ通し番号で送り直す", async () => {
    const dir = home();
    const { fetcher, sent, answer } = gate(503);
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK });
    write(dir, '{"n":1}\n');
    await expect(shipper.flush(SESSION, "ticket-1")).rejects.toThrow(/503/);
    answer.status = 204;
    await shipper.flush(SESSION, "ticket-1");
    expect(sent.map((s) => [s.seq, s.text])).toEqual([[0, '{"n":1}\n']]);
  });

  it("戻した記録を SDK の置き場に書き、その続きから次の通し番号で送る", async () => {
    const dir = home();
    const { fetcher, sent } = gate();
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK });
    await shipper.restore({ sessionId: SESSION, transcript: Buffer.from('{"n":1}\n{"n":2}\n').toString("base64"), nextSeq: 2 });
    expect(readFileSync(sessionFile(dir, WORK, SESSION), "utf8")).toBe('{"n":1}\n{"n":2}\n');
    await shipper.flush(SESSION, "ticket-1");
    expect(sent).toEqual([]);
    write(dir, '{"n":3}\n');
    await shipper.flush(SESSION, "ticket-1");
    expect(sent.map((s) => [s.seq, s.text])).toEqual([[2, '{"n":3}\n']]);
  });

  it("SDK の置き場は、動く置き場の名前の記号を - にした所", () => {
    expect(sessionFile("/home/staff", "/work", SESSION)).toBe(`/home/staff/.claude/projects/-work/${SESSION}.jsonl`);
  });

  it("記録がまだ無い session は送らない", async () => {
    const { fetcher, sent } = gate();
    await new TranscriptShipper({ fetcher, home: home(), cwd: WORK }).flush(SESSION, "ticket-1");
    expect(sent).toEqual([]);
  });
});

/** サーバーが root の時だけ確かめられる物。CI は root でないので飛ばす */
const AS_ROOT = process.getuid?.() === 0;
/** 社員の代わりの持ち主 */
const STAFF = { uid: 10001, gid: 10001 };

/**
 * 社員が先に置いた物の、名前と作り方。file は会話の記録のファイル、ほかは親のディレクトリ
 * @param dir ホーム
 * @param target すり替える先
 * @returns 名前から、すり替えを置く関数へ
 */
function plants(dir: string, target: string): Record<string, () => void> {
  const file = sessionFile(dir, WORK, SESSION);
  const parent = (path: string) => () => {
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, path);
  };
  return {
    "ファイルが symlink": () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(target, "守る中身\n");
      symlinkSync(target, file);
    },
    "ファイルがハードリンク": () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(target, "守る中身\n");
      linkSync(target, file);
    },
    "ファイルが FIFO": () => {
      mkdirSync(dirname(file), { recursive: true });
      execFileSync("mkfifo", [file]);
    },
    "ファイルがディレクトリ": () => mkdirSync(file, { recursive: true }),
    ".claude が symlink": parent(join(dir, ".claude")),
    "projects が symlink": parent(join(dir, ".claude", "projects")),
    "動く置き場の名前のディレクトリが symlink": parent(dirname(file)),
  };
}

/** 親をすり替えた名前から、すり替えた段の深さ (.claude が 0) へ */
const DEPTH: Record<string, number> = { ".claude が symlink": 0, "projects が symlink": 1, "動く置き場の名前のディレクトリが symlink": 2 };

/**
 * すり替えの先の今を読む。中身、中の名前、持ち主
 * @param target すり替えの先
 * @returns 先の今。無ければ null
 */
function stateOf(target: string): { body: string | string[]; uid: number; gid: number } | null {
  if (!existsSync(target)) return null;
  const stat = lstatSync(target);
  return { body: stat.isDirectory() ? readdirSync(target) : readFileSync(target, "utf8"), uid: stat.uid, gid: stat.gid };
}

describe("サーバーは社員が置いた symlink と FIFO を追わない", () => {
  const names = Object.keys(plants("/x", "/y"));

  it.each(names)("戻す時: %s なら断り、先を書き換えない", async (name) => {
    const dir = home();
    const target = join(home(), "target");
    plants(dir, target)[name]?.();
    const before = stateOf(target);
    const shipper = new TranscriptShipper({ fetcher: gate().fetcher, home: dir, cwd: WORK });
    await expect(shipper.restore({ sessionId: SESSION, transcript: Buffer.from('{"n":1}\n').toString("base64"), nextSeq: 1 })).rejects.toThrow(/会話の記録の置き場/);
    expect(stateOf(target)).toEqual(before);
  });

  it.each(names)("送る時: %s なら断り、中身を送らない", async (name) => {
    const dir = home();
    const target = join(home(), "target");
    plants(dir, target)[name]?.();
    // 親をすり替えた先には、送らせたいファイルを置いておく
    if (existsSync(target) && lstatSync(target).isDirectory()) {
      const rest = sessionFile(dir, WORK, SESSION).slice(join(dir, ".claude").length + 1).split("/");
      const inside = rest.slice(DEPTH[name] ?? 0);
      mkdirSync(dirname(join(target, ...inside)), { recursive: true });
      writeFileSync(join(target, ...inside), "守る中身\n");
    }
    const { fetcher, sent } = gate();
    await expect(new TranscriptShipper({ fetcher, home: dir, cwd: WORK }).flush(SESSION, "ticket-1")).rejects.toThrow(/会話の記録の置き場/);
    expect(sent).toEqual([]);
  });

  it.runIf(AS_ROOT)("戻した会話の記録は、作った置き場もファイルも社員の持ち物にする", async () => {
    const dir = home();
    const shipper = new TranscriptShipper({ fetcher: gate().fetcher, home: dir, cwd: WORK, owner: STAFF });
    await shipper.restore({ sessionId: SESSION, transcript: Buffer.from('{"n":1}\n').toString("base64"), nextSeq: 1 });
    const file = sessionFile(dir, WORK, SESSION);
    for (const path of [join(dir, ".claude"), join(dir, ".claude", "projects"), dirname(file), file]) {
      expect({ path, uid: statSync(path).uid, gid: statSync(path).gid }).toEqual({ path, ...STAFF });
    }
    expect(statSync(dir).uid).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('{"n":1}\n');
  });

  it.runIf(AS_ROOT)("社員でもサーバーでもない持ち主の置き場とファイルは断る", async () => {
    const dir = home();
    const file = sessionFile(dir, WORK, SESSION);
    mkdirSync(dirname(file), { recursive: true });
    chownSync(join(dir, ".claude"), 12345, 12345);
    const { fetcher, sent } = gate();
    const shipper = new TranscriptShipper({ fetcher, home: dir, cwd: WORK, owner: STAFF });
    await expect(shipper.restore({ sessionId: SESSION, transcript: "", nextSeq: 0 })).rejects.toThrow(/会話の記録の置き場/);
    chownSync(join(dir, ".claude"), STAFF.uid, STAFF.gid);
    for (const path of [join(dir, ".claude", "projects"), dirname(file)]) chownSync(path, STAFF.uid, STAFF.gid);
    writeFileSync(file, '{"n":1}\n');
    chownSync(file, 12345, 12345);
    await expect(shipper.flush(SESSION, "ticket-1")).rejects.toThrow(/会話の記録の置き場/);
    expect(sent).toEqual([]);
  });
});
