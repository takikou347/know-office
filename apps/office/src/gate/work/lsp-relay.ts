// エディタの補完の 1 本の中継。画面とワークスペースの間で、上りと下りの 1 件の大きさ、上りの回数、開いておく長さを数えて閉じる (タスクとレビューの 3.6)

/** 中継の上限 */
export const LSP_RELAY_LIMITS = {
  /** 画面から受ける 1 件 (1MiB)。超えたら 1009 */
  upBytes: 1024 * 1024,
  /** 画面から受ける 1 分の回数。超えたら 1008 */
  upPerMinute: 600,
  /** ワークスペースから受ける 1 件 (4MiB)。超えたら 1011 */
  downBytes: 4 * 1024 * 1024,
  /** 1 本を開いておく長さ (1 時間) */
  maxAgeMs: 60 * 60_000,
  /** 画面から送りが無ければ閉じる長さ (10 分) */
  idleMs: 10 * 60_000,
} as const;

/** 閉じる番号。RFC 6455 の 7.4.1 */
export const CLOSE = { normal: 1000, goingAway: 1001, unsupported: 1003, policy: 1008, tooBig: 1009, internal: 1011 } as const;

/** 中継が使う接続の口 */
export type RelaySocket = {
  /** 1 件送る */
  send(data: string): void;
  /** 閉じる */
  close(code: number, reason: string): void;
};

/** 時刻と、間をおいて呼ぶ口。DO は setTimeout、テストは手で進める物を渡す */
export type RelayTimers = {
  /** 今の時刻 */
  now(): number;
  /** ms の後に fn を呼ぶ。取り消す関数を返す */
  after(ms: number, fn: () => void): () => void;
};

/** 接続の印。閉じる時に選ぶのに使う */
export type RelayMeta = {
  /** ログインセッションの ID */
  sessionId: string;
  /** 送信元 */
  ip: string;
  /** 開いた時刻 */
  openedAt: number;
};

/** 1 分を数える長さ */
const MINUTE_MS = 60_000;

const encoder = new TextEncoder();

/**
 * 1 件の大きさをバイトで数える
 * @param data 文字かバイト
 * @returns バイト数
 */
function sizeOf(data: string | ArrayBuffer): number {
  return typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
}

/**
 * 接続を閉じる。閉じかけで投げても、もう片方を閉じ続ける
 * @param socket 接続
 * @param code 番号
 * @param reason 理由
 */
function shut(socket: RelaySocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // もう閉じている
  }
}

/** 画面とワークスペースの間の 1 本の中継 */
export class LspRelay {
  /** 接続の印 */
  readonly meta: RelayMeta;
  readonly #screen: RelaySocket;
  readonly #upstream: RelaySocket;
  readonly #timers: RelayTimers;
  readonly #onEnd: () => void;
  /** 直近 1 分の上りの時刻 */
  #ups: number[] = [];
  #ended = false;
  #cancelIdle: () => void;
  readonly #cancelAge: () => void;

  /**
   * 中継を始める
   * @param screen 画面の側
   * @param upstream ワークスペースの側
   * @param meta 接続の印
   * @param timers 時刻と間をおいて呼ぶ口
   * @param onEnd 閉じた時に 1 度だけ呼ぶ
   */
  constructor(screen: RelaySocket, upstream: RelaySocket, meta: RelayMeta, timers: RelayTimers, onEnd: () => void) {
    this.#screen = screen;
    this.#upstream = upstream;
    this.meta = meta;
    this.#timers = timers;
    this.#onEnd = onEnd;
    this.#cancelIdle = this.#armIdle();
    this.#cancelAge = timers.after(Math.max(0, meta.openedAt + LSP_RELAY_LIMITS.maxAgeMs - timers.now()), () => this.close(CLOSE.normal, "max age"));
  }

  /**
   * 閉じたか
   * @returns 閉じていれば true
   */
  get ended(): boolean {
    return this.#ended;
  }

  /**
   * 画面から 1 件を受け、上限の中ならワークスペースへ渡す
   * @param data 受けた物
   */
  fromScreen(data: string | ArrayBuffer): void {
    if (this.#ended) return;
    // ワークスペースは文字の 1 件だけを受ける
    if (typeof data !== "string") {
      this.close(CLOSE.unsupported, "text frames only");
      return;
    }
    const refused = this.#refuseUp(data);
    if (refused !== null) {
      this.close(refused.code, refused.reason);
      return;
    }
    this.#cancelIdle();
    this.#cancelIdle = this.#armIdle();
    this.#upstream.send(data);
  }

  /**
   * ワークスペースから 1 件を受け、上限の中なら画面へ渡す
   * @param data 受けた物
   */
  fromUpstream(data: string | ArrayBuffer): void {
    if (this.#ended) return;
    if (typeof data === "string" && sizeOf(data) <= LSP_RELAY_LIMITS.downBytes) this.#screen.send(data);
    else this.close(CLOSE.internal, "upstream message too big");
  }

  /**
   * 画面が閉じた。ワークスペースの側も閉じる
   */
  screenClosed(): void {
    this.close(CLOSE.normal, "closed");
  }

  /**
   * ワークスペースが閉じた。画面へ同じ番号で閉じる
   * @param code ワークスペースが閉じた番号
   */
  upstreamClosed(code: number): void {
    // 1005 (理由無し) と 1006 (異常) は送り返せない番号なので、ワークスペースの誤りとして閉じる
    this.close(code === 1005 || code === 1006 ? CLOSE.internal : code, "workspace closed");
  }

  /**
   * 両側を閉じる。2 度目からは何もしない
   * @param code 番号
   * @param reason 理由
   */
  close(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#cancelIdle();
    this.#cancelAge();
    shut(this.#screen, code, reason);
    shut(this.#upstream, CLOSE.normal, reason);
    this.#onEnd();
  }

  /**
   * 画面からの文字の 1 件を断るかを決める。通す時は上りの回数に数える
   * @param data 受けた文字
   * @returns 断る時の番号と理由。通すなら null
   */
  #refuseUp(data: string): { code: number; reason: string } | null {
    if (sizeOf(data) > LSP_RELAY_LIMITS.upBytes) return { code: CLOSE.tooBig, reason: "message too big" };
    const now = this.#timers.now();
    this.#ups = this.#ups.filter((at) => now - at < MINUTE_MS);
    if (this.#ups.length >= LSP_RELAY_LIMITS.upPerMinute) return { code: CLOSE.policy, reason: "too many messages" };
    this.#ups.push(now);
    return null;
  }

  /**
   * 送りが無い時に閉じる時計を掛ける
   * @returns 取り消す関数
   */
  #armIdle(): () => void {
    return this.#timers.after(LSP_RELAY_LIMITS.idleMs, () => this.close(CLOSE.normal, "idle"));
  }
}
