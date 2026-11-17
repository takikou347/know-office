// ワークスペースのエディタの補完。勤務の外に起こすかを決めて起こし、木を 1 度だけ渡させ、中継を 1 本だけ持ち、補完で起こした物を期限と予算で止める (タスクとレビューの 3.6、社員が考えるの 3.2)
import { AppError, jstDay, LspTreeParams } from "@know-office/core";
import { z } from "zod";
import { CLOSE, LspRelay, type RelayMeta, type RelaySocket, type RelayTimers } from "./lsp-relay.ts";

/** 補完で起こす時の上限 */
export const EDITOR_LIMITS = {
  /** 1 回に起こしておく長さ (1 時間)。接続があっても止める */
  wakeMs: 60 * 60_000,
  /** 1 日 (日本時間) に補完で起こしておける長さ (2 時間) */
  dayMs: 2 * 60 * 60_000,
  /** 補完の接続が無くなってから止めるまで (10 分) */
  idleMs: 10 * 60_000,
  /** 止めるのに落ちた時に掛け直すまで (1 分) */
  retryMs: 60_000,
  /** tarball を取る 1 時間の回数 */
  pullsPerHour: 20,
  /** tarball を取る 1 日の回数 */
  pullsPerDay: 100,
} as const;

/** 起きていない時に待たせる秒。勤務の間はハートビートの作り直しを待つ */
const RETRY_AFTER_S = 30;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** 補完が使うワークスペースの口。WorkspaceBox が持つ */
export type LspBox = {
  /** 動いているか */
  readonly running: boolean;
  /** 起こしている途中と止めている途中の物が終わるまで待つ */
  settled(): Promise<void>;
  /** 1 回だけ起こす。やり直さず、知らせない */
  wakeOnce(): Promise<void>;
  /** 止める */
  stop(): Promise<void>;
  /** その木の今の先。無ければ null */
  lspTreeSha(nodeId: string): Promise<string | null>;
  /** 木 (tar.gz) を渡す */
  putLspTree(nodeId: string, sha: string, body: ReadableStream<Uint8Array>): Promise<void>;
};

/** 記憶の口。DO の ctx.storage と同じ形 */
export type EditorStorage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

/** EditorLsp の依り所 */
export type EditorDeps = {
  /** ワークスペース */
  box: LspBox;
  /** 起こした訳と予算と回数を置く記憶 */
  storage: EditorStorage;
  /** 時刻と、間をおいて呼ぶ口 */
  timers: RelayTimers;
  /** 止めるかを確かめる alarm を掛ける */
  setAlarm(at: number): Promise<void>;
  /** 中継が閉じた時に呼ぶ。配信の同時の数から外す */
  onRelayEnd?(meta: RelayMeta): void;
};

/** 補完の接続を閉じる相手。ログアウトはそのセッション、締め出しはその送信元、全部のログアウトと全体の停止は except 以外 */
export type LspCloseFilter = { sessionId: string } | { ip: string } | { except: string | null };

/** 記憶に置く物 */
const EditorState = z.object({
  /** 起こした訳。editor は補完、shift は勤務。null は止まっているか分からない */
  by: z.enum(["editor", "shift"]).nullable(),
  /** 補完で起こした時刻 */
  wokeAt: z.number().nullable(),
  /** 最後に接続を受けたか閉じた時刻 */
  lastAt: z.number().nullable(),
  /** 補完で起こした長さを数える日 (日本時間) */
  day: z.string(),
  /** その日に補完で起こした長さ */
  usedMs: z.number(),
  /** tarball を取った時刻。直近 1 日分 */
  pulls: z.array(z.number()),
});
type EditorState = z.infer<typeof EditorState>;

const STATE_KEY = "editor";

/** 合図で終わる約束 */
type Claim = { promise: Promise<void>; resolve: () => void };

/**
 * 合図で終わる約束を作る
 * @returns 約束と終わらせる関数
 */
function claim(): Claim {
  let done: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, resolve: () => done?.() };
}

/** ワークスペース 1 つのエディタの補完。WorkspaceDO が 1 つ持つ */
export class EditorLsp {
  readonly #deps: EditorDeps;
  #state: EditorState | null = null;
  #active: LspRelay | null = null;
  /** 木を渡している途中の物。「nodeId:sha」から */
  readonly #claims = new Map<string, Claim>();
  /** 補完で起こした物を止めている途中の物 */
  #stopping: Promise<void> | null = null;

  /**
   * 補完の中身を作る
   * @param deps ワークスペース、記憶、時刻、alarm
   */
  constructor(deps: EditorDeps) {
    this.#deps = deps;
  }

  /**
   * 接続の前の支度。止めている途中なら待ち、止まっていて起こしてよければ 1 回だけ起こし、木が今の先でなければ取りに行く役を 1 本にだけ渡す
   * @param input 木の名前、起こしてよいか、時刻
   * @param input.nodeId タスク
   * @param input.sha 先のコミット
   * @param input.wake 止まっている時に起こしてよいか
   * @param input.now 今の時刻
   * @returns tree は ready (今の木がある) か needed (取って putTree か dropTree を呼ぶ)、woke は起こしたか
   * @throws unavailable 止まっていて起こさない時、起きなかった時
   * @throws rate_limited 1 日の予算を使い切った時、tarball の回数が上限の時
   * @throws upstream_failed 木の名前の形が違う時
   */
  async prepare(input: { nodeId: string; sha: string; wake: boolean; now: number }): Promise<{ tree: "ready" | "needed"; woke: boolean }> {
    const params = LspTreeParams.safeParse({ nodeId: input.nodeId, sha: input.sha });
    if (!params.success) throw new AppError("upstream_failed", "木の名前の形が違う");
    const state = await this.#load();
    // 止めている最中に来た接続は、止め終わってから起こすかを決める
    await this.#stopping;
    await this.#deps.box.settled();
    let woke = false;
    if (!this.#deps.box.running) {
      if (!input.wake) throw new AppError("unavailable", "ワークスペースが動いていない", { headers: { "Retry-After": String(RETRY_AFTER_S) } });
      const used = this.#usedOn(state, input.now);
      if (used >= EDITOR_LIMITS.dayMs) throw new AppError("rate_limited", "今日の補完で起こせる時間を使い切った", { headers: { "Retry-After": String(HOUR_MS / 1000) } });
      Object.assign(state, { by: "editor", wokeAt: input.now, lastAt: input.now, day: jstDay(input.now), usedMs: used });
      await this.#save();
      try {
        await this.#deps.box.wakeOnce();
      } catch {
        // 起きなかった時はやり直さず、通知も出さない。画面がつなぎ直す
        Object.assign(state, { by: null, wokeAt: null });
        await this.#save();
        throw new AppError("unavailable", "ワークスペースが起きない", { headers: { "Retry-After": String(RETRY_AFTER_S) } });
      }
      woke = true;
    }
    // 止める判断より先に「最後の接続」を書き、10 分の判断で止めさせない
    state.lastAt = input.now;
    await this.#save();
    this.#schedule();
    return { tree: await this.#tree(params.data, input.now), woke };
  }

  /**
   * 取った木をワークスペースに渡す。渡し終えたら、待っていた接続を通す
   * @param nodeId タスク
   * @param sha 先のコミット
   * @param body tar.gz
   * @returns 無し
   * @throws upstream_failed ワークスペースが木を断った時
   */
  async putTree(nodeId: string, sha: string, body: ReadableStream<Uint8Array>): Promise<null> {
    try {
      await this.#deps.box.putLspTree(nodeId, sha, body);
    } finally {
      this.#release(`${nodeId}:${sha}`);
    }
    return null;
  }

  /**
   * 木を取れなかった。待っていた接続に自分で取りに行かせる
   * @param nodeId タスク
   * @param sha 先のコミット
   * @returns 無し
   */
  dropTree(nodeId: string, sha: string): Promise<null> {
    this.#release(`${nodeId}:${sha}`);
    return Promise.resolve(null);
  }

  /**
   * 画面とワークスペースの接続をつなぐ。新しい接続を受けてから前の物を 1008 で閉じる
   * @param screen 画面の側
   * @param upstream ワークスペースの側
   * @param meta 接続の印
   * @returns 中継
   */
  attach(screen: RelaySocket, upstream: RelaySocket, meta: RelayMeta): LspRelay {
    const relay: LspRelay = new LspRelay(screen, upstream, meta, this.#deps.timers, () => {
      if (this.#active === relay) this.#active = null;
      if (this.#state) this.#state.lastAt = this.#deps.timers.now();
      this.#saveLater();
      this.#schedule();
      this.#deps.onRelayEnd?.(meta);
    });
    const previous = this.#active;
    this.#active = relay;
    previous?.close(CLOSE.policy, "replaced by a new connection");
    this.#schedule();
    return relay;
  }

  /**
   * 合う補完の接続を 1008 で閉じる
   * @param filter 閉じる相手
   */
  close(filter: LspCloseFilter): void {
    const relay = this.#active;
    if (!relay) return;
    let hit = relay.meta.sessionId !== ("except" in filter ? filter.except : null);
    if ("sessionId" in filter) hit = relay.meta.sessionId === filter.sessionId;
    if ("ip" in filter) hit = relay.meta.ip === filter.ip;
    if (hit) relay.close(CLOSE.policy, "closed by owner");
  }

  /**
   * 出勤の start と run が来た。訳を勤務に替え、補完の期限では止めさせない。補完で起こしていた長さは予算に足す
   * @returns 無し
   */
  async markShift(): Promise<void> {
    const state = await this.#load();
    this.#settleUsed(state, this.#deps.timers.now());
    state.by = "shift";
    await this.#save();
  }

  /**
   * ワークスペースをほかの訳 (退勤、作り直し) で止めた。補完の接続を閉じ、補完で起こしていた長さを予算に足す
   * @returns 無し
   */
  async stopped(): Promise<void> {
    const state = await this.#load();
    this.#active?.close(CLOSE.goingAway, "workspace stopped");
    this.#settleUsed(state, this.#deps.timers.now());
    state.by = null;
    await this.#save();
  }

  /**
   * alarm で、補完で起こした物の期限、予算、接続の無い長さを確かめ、過ぎていれば止める。止められなければ 1 分後に掛け直す
   * @param now 今の時刻
   * @returns 無し
   */
  async alarm(now: number): Promise<void> {
    await this.#check(now);
  }

  /**
   * 5 分ごとの確かめ。alarm が消えていても、補完で起こした物の期限が過ぎていれば止める
   * @param now 今の時刻
   * @returns 無し
   */
  async sweep(now: number): Promise<void> {
    await this.#check(now);
  }

  /**
   * 止めるかを決めて止める。決めてから止めるまでに await を挟まず、訳を先に替える
   * @param now 今の時刻
   */
  async #check(now: number): Promise<void> {
    const state = this.#state ?? (await this.#load());
    if (this.#stopping) return;
    if (!this.#due(state, now)) {
      this.#schedule();
      return;
    }
    const before = { ...state };
    this.#active?.close(CLOSE.goingAway, "workspace stopped");
    this.#settleUsed(state, now);
    state.by = null;
    this.#stopping = (async () => {
      try {
        await this.#save();
        await this.#deps.box.stop();
      } catch {
        // 止められなかった。間に勤務が始まっていなければ補完の訳に戻し、1 分後に確かめ直す
        if (state.by === null) Object.assign(state, { by: before.by, wokeAt: before.wokeAt, usedMs: before.usedMs, day: before.day });
        await this.#save().catch(() => undefined);
        await this.#deps.setAlarm(now + EDITOR_LIMITS.retryMs).catch(() => undefined);
      }
    })().finally(() => {
      this.#stopping = null;
    });
    await this.#stopping;
  }

  /**
   * 補完で起こした物を止める時か
   * @param state 記憶
   * @param now 今の時刻
   * @returns 止める時なら true
   */
  #due(state: EditorState, now: number): boolean {
    const next = this.#next(state);
    return next !== null && now >= next;
  }

  /**
   * 補完で起こした物を止める時刻。起こしてから 1 時間、予算を使い切る時刻、接続が無ければ最後の接続から 10 分の早い方
   * @param state 記憶
   * @returns 時刻。補完で起こしていなければ null
   */
  #next(state: EditorState): number | null {
    if (state.by !== "editor" || state.wokeAt === null) return null;
    const used = state.day === jstDay(state.wokeAt) ? state.usedMs : 0;
    const candidates = [state.wokeAt + EDITOR_LIMITS.wakeMs, state.wokeAt + EDITOR_LIMITS.dayMs - used];
    if (this.#active === null) candidates.push((state.lastAt ?? state.wokeAt) + EDITOR_LIMITS.idleMs);
    return Math.min(...candidates);
  }

  /**
   * 次に止めるかを確かめる alarm を掛ける。補完で起こしていなければ掛けない
   */
  #schedule(): void {
    if (!this.#state) return;
    const next = this.#next(this.#state);
    if (next !== null) this.#deps.setAlarm(next).catch(() => undefined);
  }

  /**
   * 補完で起こしていた長さを、その日の予算に足す
   * @param state 記憶
   * @param now 今の時刻
   */
  #settleUsed(state: EditorState, now: number): void {
    if (state.by !== "editor" || state.wokeAt === null) return;
    const day = jstDay(state.wokeAt);
    state.usedMs = (state.day === day ? state.usedMs : 0) + Math.max(0, now - state.wokeAt);
    state.day = day;
    state.wokeAt = null;
  }

  /**
   * 今日に補完で起こした長さ
   * @param state 記憶
   * @param now 今の時刻
   * @returns ミリ秒
   */
  #usedOn(state: EditorState, now: number): number {
    return state.day === jstDay(now) ? state.usedMs : 0;
  }

  /**
   * 木が今の先かを確かめ、違えば取りに行く役を 1 本にだけ渡す。ほかの接続は渡し終えるのを待って確かめ直す
   * @param params 木の名前
   * @param now 今の時刻
   * @returns ready か needed
   * @throws rate_limited tarball の回数が上限の時
   */
  async #tree(params: LspTreeParams, now: number): Promise<"ready" | "needed"> {
    const key = `${params.nodeId}:${params.sha}`;
    for (;;) {
      const pending = this.#claims.get(key);
      if (pending) {
        await pending.promise;
        continue;
      }
      this.#claims.set(key, claim());
      let current: string | null;
      try {
        current = await this.#deps.box.lspTreeSha(params.nodeId);
      } catch (error) {
        this.#release(key);
        throw error;
      }
      if (current === params.sha) {
        this.#release(key);
        return "ready";
      }
      const state = await this.#load();
      // 取る前に数える。直近 1 時間と 1 日の回数
      state.pulls = state.pulls.filter((at) => now - at < DAY_MS);
      const hour = state.pulls.filter((at) => now - at < HOUR_MS).length;
      if (hour >= EDITOR_LIMITS.pullsPerHour || state.pulls.length >= EDITOR_LIMITS.pullsPerDay) {
        this.#release(key);
        throw new AppError("rate_limited", "木を取る回数が多すぎる", { headers: { "Retry-After": String(HOUR_MS / 1000) } });
      }
      state.pulls.push(now);
      await this.#save();
      return "needed";
    }
  }

  /**
   * 木を渡す役を終え、待っていた接続を通す
   * @param key 「nodeId:sha」
   */
  #release(key: string): void {
    const held = this.#claims.get(key);
    this.#claims.delete(key);
    held?.resolve();
  }

  /**
   * 記憶を読む。初めの 1 回だけ読み、後は手元の物を使う
   * @returns 記憶
   */
  async #load(): Promise<EditorState> {
    if (this.#state) return this.#state;
    const stored = EditorState.safeParse(await this.#deps.storage.get(STATE_KEY));
    this.#state ??= stored.success ? stored.data : { by: null, wokeAt: null, lastAt: null, day: "", usedMs: 0, pulls: [] };
    return this.#state;
  }

  /**
   * 記憶に書く
   * @returns 無し
   */
  async #save(): Promise<void> {
    if (this.#state) await this.#deps.storage.put(STATE_KEY, this.#state);
  }

  /**
   * 待たずに記憶に書く。中継が閉じた時など、await できない所で使う
   */
  #saveLater(): void {
    this.#save().catch(() => undefined);
  }
}
