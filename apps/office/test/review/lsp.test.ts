// エディタの補完の切り替え GET /api/v1/reviews/{nodeId}/lsp。Origin、ログインセッション、配信の作業トークン、nodeId、レビュー、ルールの順に確かめ、勤務の外は EDITOR_WAKE で起こすかを決め、木が無い時だけ tarball を流す (タスクとレビューの 3.2)
import { gzipSync } from "node:zlib";
import { LSP_TREE_BYTES, newId, Problem, type StaffId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { stops, stopUpdates } from "../../src/gate/db/main.ts";
import { closeLspAll } from "../../src/gate/live/lsp.ts";
import { EditorLsp } from "../../src/gate/work/editor-lsp.ts";
import { workspaceFake } from "../helpers/staff-runs.ts";
import { type FakeBox, fakeBox, type FakeSocket, fakeSocket, ManualTimers, memory } from "../helpers/lsp.ts";
import { overRpc } from "../helpers/rpc.ts";
import { HEAD, openReview } from "../helpers/review.ts";
import { REPO, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

const TARBALL = gzipSync(Buffer.from("木の中身"));
const OLD = "d".repeat(40);

/** 社員 1 人の補完の DO の中身と、開いた接続 */
type LspWorld = { box: FakeBox; editor: EditorLsp; timers: ManualTimers; screens: FakeSocket[]; closes: unknown[]; opened: Record<string, string>[]; heldAtOpen: unknown[][]; failOpen: boolean };

/** 開いたレビュー */
let task = "";
/** 社員ごとの補完の DO の中身 */
let lsp: Record<StaffId, LspWorld>;
/** 社員の勤務の状態を差し替える。null なら本物の状態 */
let shiftState: string | null = null;

/**
 * 社員 1 人の補完の DO の中身を作る
 * @param w テストの物
 * @returns 中身
 */
function lspWorld(w: WorkWorld): LspWorld {
  const box = fakeBox();
  const timers = new ManualTimers(w.clock.now());
  const editor = new EditorLsp({ box, storage: memory(), timers, setAlarm: () => Promise.resolve() });
  return { box, editor, timers, screens: [], closes: [], opened: [], heldAtOpen: [], failOpen: false };
}

/**
 * ゲートウェイの WORKSPACE を、本物の補完の中身と代わりのワークスペースを持つ物に差し替え、社員の勤務の状態を差し替えられるようにする
 * @param w テストの物
 */
function wire(w: WorkWorld): void {
  lsp = { president: lspWorld(w), builder: lspWorld(w), reviewer: lspWorld(w) };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const env = w.gate.env as unknown as Record<string, unknown>;
  env["WORKSPACE"] = {
    idFromName: (name: StaffId) => ({ toString: () => `ws-${name}`, name }),
    get: (id: { name: StaffId }) => {
      const l = lsp[id.name];
      return {
        ...workspaceFake(w.gate.workspaces[id.name]),
        lspPrepare: overRpc((input: { nodeId: string; sha: string; wake: boolean; now: number }) => l.editor.prepare(input)),
        lspPutTree: overRpc((nodeId: string, sha: string, claim: string, body: ReadableStream<Uint8Array>) => l.editor.putTree(nodeId, sha, claim, body)),
        lspDropTree: overRpc((nodeId: string, sha: string, claim: string) => l.editor.dropTree(nodeId, sha, claim)),
        closeLsp: (filter: { sessionId: string } | { ip: string } | { except: string | null }) => {
          l.closes.push(filter);
          l.editor.close(filter);
          return Promise.resolve(null);
        },
        fetch: (_url: string, init?: { headers?: Record<string, string> }) => {
          const headers = init?.headers ?? {};
          l.opened.push(headers);
          l.heldAtOpen.push([...w.gate.live.lsp]);
          if (l.failOpen) return Promise.resolve(new Response(null, { status: 503 }));
          const screen = fakeSocket();
          l.screens.push(screen);
          l.editor.attach(screen, fakeSocket(), { sessionId: headers["x-lsp-session"] ?? "", ip: headers["x-lsp-ip"] ?? "", openedAt: Number(headers["x-lsp-at"]) });
          // workerd でないので 101 は作れない。切り替えまで届いた事だけを 200 で返す
          return Promise.resolve(new Response("opened", { status: 200 }));
        },
      };
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const staffNs = env["STAFF"] as { idFromName(name: StaffId): StaffId; get(id: StaffId): { status(now: number): Promise<{ state: string }> } };
  env["STAFF"] = {
    idFromName: (name: StaffId) => staffNs.idFromName(name),
    get: (id: StaffId) => {
      const real = staffNs.get(id);
      return { ...real, status: async (now: number) => ({ ...(await real.status(now)), ...(shiftState === null ? {} : { state: shiftState }) }) };
    },
  };
}

beforeEach(async () => {
  shiftState = "off";
  ({ task } = await openReview(world));
  world.gate.github.archives.set(`${REPO}:${HEAD}`, TARBALL);
  wire(world);
  world.gate.env.EDITOR_WAKE = "on";
});

const Ticket = z.object({ data: z.object({ ticket: z.string() }) });

/**
 * 配信の作業トークンを出させる
 * @param headers ログインの見出し
 * @returns 作業トークン
 */
async function ticket(headers = world.headers): Promise<string> {
  const res = await world.gate.request("/api/v1/live/tickets", { method: "POST", headers });
  return Ticket.parse(await res.json()).data.ticket;
}

/**
 * 補完に切り替えに行く
 * @param options nodeId、作業トークン、足すか消す見出し
 * @param options.nodeId タスク。無ければ開いたレビュー
 * @param options.value 作業トークン。無ければ新しく出す
 * @param options.extra 足す見出し。null は消す
 * @param options.headers ログインの見出し
 * @returns 返事
 */
async function open(options: { nodeId?: string; value?: string; extra?: Record<string, string | null>; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers = options.headers ?? world.headers;
  const value = options.value ?? (await ticket(headers));
  const sent: Record<string, string> = { ...headers, Upgrade: "websocket" };
  for (const [name, v] of Object.entries(options.extra ?? {})) {
    if (v === null) delete sent[name];
    else sent[name] = v;
  }
  return world.gate.request(`/api/v1/reviews/${options.nodeId ?? task}/lsp?ticket=${encodeURIComponent(value)}`, { headers: sent });
}

/**
 * 返事の problem の code
 * @param res 返事
 * @returns status と code
 */
async function problem(res: Response): Promise<string> {
  return `${String(res.status)} ${Problem.parse(await res.json()).code}`;
}

/**
 * 代わりの GitHub に届いた tarball の要求の数
 * @returns 数
 */
function tarballReads(): number {
  return world.gate.github.requests.filter((r) => r.route.includes("/tarball/")).length;
}

/**
 * 止めた記録を置く
 * @param scope office か staff
 * @param target 相手
 */
async function addStop(scope: "office" | "staff", target: string): Promise<void> {
  const now = world.clock.now();
  await drizzle(world.d1.DB).insert(stops).values({ id: newId({ now: () => now }), at: now, kind: "stop", scope, target, signal: "manual", measured: 1, threshold: 1, rulesVersion: 0, recentOpsKey: null, nodeProgress: null, externalSources: [], model: null, by: "owner" });
}

describe("ワークスペースを起こす時", () => {
  it("補完を使う", async () => {
    const res = await open();
    expect(res.status).toBe(200);
    const b = lsp.builder;
    // 作った社員のワークスペースを 1 回起こし、今の先の木を渡してからつなぐ
    expect([b.box.wakes, b.box.puts]).toEqual([1, [`${task}:${HEAD}`]]);
    expect(tarballReads()).toBe(1);
    expect(b.opened).toHaveLength(1);
    expect(b.opened[0]).toMatchObject({ Upgrade: "websocket", "x-lsp-node": task, "x-lsp-sha": HEAD });
    expect([lsp.president.box.wakes, lsp.reviewer.box.wakes]).toEqual([0, 0]);
    // 勤務の外に起こした事を監査ログに残し、配信の同時の数に入れる
    expect(world.gate.audits.filter((a) => a.action === "workspace.wake").map((a) => a.target)).toEqual(["builder"]);
    expect(world.gate.live.lsp).toEqual([{ staffId: "builder", openedAt: world.clock.now() }]);
  });

  it("補完の接続は中継を始める前に配信の同時の数に入れ、ワークスペースにつながらなければ放す", async () => {
    lsp.builder.box.trees.set(task, HEAD);
    lsp.builder.failOpen = true;
    const res = await open();
    expect(await problem(res)).toBe("503 unavailable");
    expect(lsp.builder.heldAtOpen).toEqual([[{ staffId: "builder", openedAt: world.clock.now() }]]);
    expect(world.gate.live.lsp).toEqual([]);
  });

  it("Origin が違えば配信の作業トークンを使わずに 403", async () => {
    const value = await ticket();
    expect(await problem(await open({ value, extra: { Origin: "http://evil.example" } }))).toBe("403 origin_mismatch");
    expect(await problem(await open({ value, extra: { Origin: null } }))).toBe("403 origin_mismatch");
    expect((await open({ value })).status).toBe(200);
  });

  it("Upgrade が無ければ 400、配信の作業トークンが使用済みか 60 秒を過ぎていれば 401", async () => {
    const value = await ticket();
    expect(await problem(await open({ value, extra: { Upgrade: null } }))).toBe("400 malformed_request");
    expect((await open({ value })).status).toBe(200);
    expect(await problem(await open({ value }))).toBe("401 unauthenticated");
    const late = await ticket();
    world.clock.advance(60_000);
    world.headers = await world.gate.signIn();
    expect(await problem(await open({ value: late }))).toBe("401 unauthenticated");
    expect(lsp.builder.opened).toHaveLength(1);
  });

  it("nodeId が UUID でなければ 422", async () => {
    const answers: string[] = [];
    for (const nodeId of ["abc", task.toUpperCase(), `${task.slice(0, -2)}..`, encodeURIComponent(`../${task}`), encodeURIComponent(`${task}/x`)]) {
      const value = await ticket();
      answers.push(await problem(await open({ nodeId, value })));
    }
    expect(answers).toEqual(Array(5).fill("422 validation_failed"));
    expect(lsp.builder.box.wakes).toBe(0);
  });

  it("レビューが無いタスクは 404、ルールで読めないリポジトリは 403", async () => {
    expect(await problem(await open({ nodeId: "0190f4a8-0000-7000-8000-00000000ffff" }))).toBe("404 not_found");
    // できる操作から読むを外す
    await world.d1.DB.prepare("INSERT INTO settings (id, key, scope, value, version, changed_by, reason, created_at) VALUES (?, 'service.actions', 'office', ?, 9, 'owner', 'テスト', 1)").bind(crypto.randomUUID(), JSON.stringify(["branch"])).run();
    expect(await problem(await open())).toBe("403 rule_denied");
    expect(lsp.builder.box.wakes).toBe(0);
    expect(tarballReads()).toBe(0);
  });

  it("ワークスペースに渡す nodeId と sha は確かめた物だけで道を組む (短い sha、大文字の sha を持つレビューの行は 502 で渡さない)", async () => {
    for (const sha of ["c".repeat(7), "C".repeat(40)]) {
      await world.d1.DB.prepare("UPDATE reviews SET head_sha = ? WHERE node_id = ?").bind(sha, task).run();
      expect(await problem(await open())).toBe("502 upstream_failed");
    }
    expect(lsp.builder.box.wakes).toBe(0);
    expect(tarballReads()).toBe(0);
  });

  it("勤務の外で EDITOR_WAKE が off なら、ワークスペースを起こさずに 503 と Retry-After", async () => {
    world.gate.env.EDITOR_WAKE = "off";
    const res = await open();
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await problem(res)).toBe("503 unavailable");
    expect(lsp.builder.box.wakes).toBe(0);
    // 設定が無い時も off とみる
    world.gate.env.EDITOR_WAKE = undefined;
    expect(await problem(await open())).toBe("503 unavailable");
    expect(lsp.builder.box.wakes).toBe(0);
  });

  it("勤務の間でワークスペースが止まっていれば、EDITOR_WAKE が on でも起こさずに 503", async () => {
    shiftState = "working";
    expect(await problem(await open())).toBe("503 unavailable");
    expect(lsp.builder.box.wakes).toBe(0);
    // 動いていればつなぐ
    lsp.builder.box.isRunning = true;
    expect((await open()).status).toBe(200);
    expect(world.gate.audits.filter((a) => a.action === "workspace.wake")).toEqual([]);
  });

  it("EDITOR_WAKE が on なら 1 回だけ起こし、起きなければやり直さず通知も出さずに 503", async () => {
    lsp.builder.box.wakeFails = true;
    expect(await problem(await open())).toBe("503 unavailable");
    expect(lsp.builder.box.wakes).toBe(1);
    expect(await rows(world.d1.DB, "SELECT kind FROM notices WHERE kind = 'workspace_down'")).toEqual([]);
  });

  it("全体の停止中は EDITOR_WAKE が on でも起こさない", async () => {
    await addStop("office", "office");
    expect(await problem(await open())).toBe("503 unavailable");
    expect(lsp.builder.box.wakes).toBe(0);
  });

  it("社員の停止中は EDITOR_WAKE が on でも起こさない", async () => {
    await addStop("staff", "builder");
    expect(await problem(await open())).toBe("503 unavailable");
    // 再開した後は起こす
    const [stop] = await drizzle(world.d1.DB).select({ id: stops.id }).from(stops);
    const now = world.clock.now();
    await drizzle(world.d1.DB).insert(stopUpdates).values({ id: newId({ now: () => now }), stopId: stop?.id ?? "", at: now, kind: "resumed", by: "owner", verdict: null, reason: "再開" });
    // ほかの社員の停止では止めない
    await addStop("staff", "reviewer");
    expect((await open()).status).toBe(200);
    expect(lsp.builder.box.wakes).toBe(1);
  });

  it("ログアウトした後のセッションでは EDITOR_WAKE が on でも起こさない", async () => {
    const value = await ticket();
    const me = z.object({ data: z.array(z.object({ id: z.string(), current: z.boolean() }).loose()) }).parse(await (await world.gate.request("/api/v1/sessions", { headers: world.headers })).json());
    const id = me.data.find((s) => s.current)?.id ?? "";
    expect((await world.gate.request(`/api/v1/sessions/${id}`, { method: "DELETE", headers: world.headers })).status).toBe(204);
    expect((await open({ value })).status).toBe(401);
    expect(lsp.builder.box.wakes).toBe(0);
  });

  it("勤務の外に起こした時間が 1 日 2 時間に届いていれば 429", async () => {
    const b = lsp.builder;
    // 補完で 2 時間を使い切る
    for (let n = 0; n < 2; n += 1) {
      const prepared = await b.editor.prepare({ nodeId: task, sha: OLD, wake: true, now: b.timers.now() }).catch(() => null);
      await b.editor.dropTree(task, OLD, prepared?.claim ?? "");
      b.timers.advance(3_600_000);
      await b.editor.alarm(b.timers.now());
    }
    const res = await open();
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(await problem(res)).toBe("429 rate_limited");
  });

  it("ワークスペースに今の先の木がある時は GitHub を呼ばない", async () => {
    lsp.builder.box.trees.set(task, HEAD);
    expect((await open()).status).toBe(200);
    expect(tarballReads()).toBe(0);
    expect(lsp.builder.box.puts).toEqual([]);
  });

  it("tarball が 50MiB を超えたら流す途中で止めて 502、ワークスペースの前の木は残る", async () => {
    world.gate.github.archives.set(`${REPO}:${HEAD}`, new Uint8Array(LSP_TREE_BYTES + 1));
    lsp.builder.box.trees.set(task, OLD);
    expect(await problem(await open())).toBe("502 upstream_failed");
    expect(lsp.builder.box.trees.get(task)).toBe(OLD);
    expect(lsp.builder.opened).toEqual([]);
    // 取れなかった後も、次の接続は取りに行ける
    world.gate.github.archives.set(`${REPO}:${HEAD}`, TARBALL);
    expect((await open()).status).toBe(200);
    expect(lsp.builder.box.trees.get(task)).toBe(HEAD);
  });

  it("同じ session で 2 本を同時に開くと、木を渡すのは 1 度で、新しい接続を受けてから前の接続を 1008 で閉じる", async () => {
    const [a, b] = await Promise.all([ticket(), ticket()]);
    const answers = await Promise.all([open({ value: a }), open({ value: b })]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(tarballReads()).toBe(1);
    expect(lsp.builder.box.puts).toHaveLength(1);
    const [first, second] = lsp.builder.screens;
    expect(first?.closed?.code).toBe(1008);
    expect(second?.closed).toBeNull();
  });
});

describe("読みやすさと補完", () => {
  it("ログアウトでそのセッションの補完の接続を閉じる", async () => {
    expect((await open()).status).toBe(200);
    const me = z.object({ data: z.array(z.object({ id: z.string(), current: z.boolean() }).loose()) }).parse(await (await world.gate.request("/api/v1/sessions", { headers: world.headers })).json());
    const id = me.data.find((s) => s.current)?.id ?? "";
    expect((await world.gate.request(`/api/v1/sessions/${id}`, { method: "DELETE", headers: world.headers })).status).toBe(204);
    expect(lsp.builder.screens[0]?.closed?.code).toBe(1008);
    expect(Object.values(lsp).map((l) => l.closes)).toEqual([[{ sessionId: id }], [{ sessionId: id }], [{ sessionId: id }]]);
  });

  it("全部のログアウトで今のセッションのほかの補完の接続を閉じる", async () => {
    const other = await world.gate.signIn();
    expect((await open({ headers: other })).status).toBe(200);
    expect((await world.gate.request("/api/v1/sessions", { method: "DELETE", headers: world.headers })).status).toBe(204);
    expect(lsp.builder.screens[0]?.closed?.code).toBe(1008);
    // 今のセッションの接続は残す
    expect((await open()).status).toBe(200);
    expect((await world.gate.request("/api/v1/sessions", { method: "DELETE", headers: world.headers })).status).toBe(204);
    expect(lsp.builder.screens[1]?.closed).toBeNull();
  });

  it("送信元の締め出しでその送信元の補完の接続を閉じる", async () => {
    expect((await open()).status).toBe(200);
    const ip = lsp.builder.opened[0]?.["x-lsp-ip"] ?? "";
    await closeLspAll(world.gate.env, world.clock, { ip: "198.51.100.9" });
    expect(lsp.builder.screens[0]?.closed).toBeNull();
    await closeLspAll(world.gate.env, world.clock, { ip });
    expect(lsp.builder.screens[0]?.closed?.code).toBe(1008);
  });

  it("全体の停止で全部の補完の接続を閉じる", async () => {
    expect((await open()).status).toBe(200);
    const res = await world.gate.request("/api/v1/guard/stops", { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "office", target: "office", reason: "確かめ" }) });
    expect(res.status).toBe(201);
    expect(lsp.builder.screens[0]?.closed?.code).toBe(1008);
    expect(lsp.builder.closes).toEqual([{ except: null }]);
  });
});
