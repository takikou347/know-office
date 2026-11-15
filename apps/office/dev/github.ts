// 開発環境の代わりの GitHub。テストが置いた返事を返し、App の作成とインストール、App の鍵からの絞った鍵、git の受け口、署名付きの通知を GitHub と同じ形で持つ
import { createHmac, generateKeyPairSync, type KeyObject } from "node:crypto";
import { Hono } from "hono";
import { decodeJwt, jwtVerify } from "jose";
import { z } from "zod";

const FakeRoute = z.object({ route: z.string(), body: z.unknown() });

/** 代わりの GitHub の App が持てる権限。know-office の manifest と同じ */
const Permission = z.enum(["read", "write"]);
const Manifest = z
  .object({
    name: z.string().min(1),
    url: z.string(),
    redirect_url: z.string(),
    setup_url: z.string(),
    hook_attributes: z.object({ url: z.string() }).loose(),
    public: z.boolean(),
    default_permissions: z.record(z.string(), Permission),
    default_events: z.array(z.string()),
  })
  .loose();
const TokenRequest = z.object({ repositories: z.array(z.string()).optional(), permissions: z.record(z.string(), Permission).optional() }).strict();

/** 届いた要求 */
export type GitHubRequest = {
  /** 「メソッド パス」 */
  route: string;
  /** 本文。JSON でなければ null */
  body: unknown;
  /** 付いていた鍵。Bearer か、git の Basic の合言葉 */
  token: string | null;
};

/** 代わりの GitHub が作った App */
export type FakeApp = {
  /** App ID */
  id: number;
  /** URL に入る名前 */
  slug: string;
  /** 受けた manifest */
  manifest: z.infer<typeof Manifest>;
  /** 通知の秘密 */
  webhookSecret: string;
  /** 秘密鍵に対の公開鍵。App の JWT を確かめる */
  publicKey: KeyObject;
};

/** 代わりの GitHub が出した、インストールの 1 時間の鍵 */
export type FakeToken = {
  /** インストール ID */
  installationId: number;
  /** 届くリポジトリ (owner/name)。null はインストールで選んだすべて */
  repos: string[] | null;
  /** 権限 */
  permissions: Record<string, "read" | "write">;
  /** 期限 (協定世界時のミリ秒) */
  expiresAt: number;
};

/** 代わりの GitHub */
export type FakeGitHub = {
  /** GitHub の REST API、画面、git の形の Hono。画面は /web、git は /git の下 */
  app: Hono;
  /** 届いた要求 */
  requests: GitHubRequest[];
  /** 「メソッド パス」に返す本文を置く。undefined は置いた本文を消し、404 に戻す */
  set(route: string, body: unknown): void;
  /** 作った App。ID から */
  apps: Map<number, FakeApp>;
  /** インストール。ID から、App ID と選んだリポジトリ */
  installations: Map<number, { appId: number; repos: string[] }>;
  /** 出した 1 時間の鍵。鍵から */
  tokens: Map<string, FakeToken>;
  /** 次のインストールでオーナーが選ぶリポジトリと、公開か */
  pick: { fullName: string; private: boolean }[];
  /** オーナーが GitHub の画面で App を外す */
  uninstall(installationId: number): void;
};

/** 代わりの GitHub の設定 */
export type FakeGitHubOptions = {
  /** 今の時刻。1 時間の鍵の期限と、App の JWT の期限に使う */
  now?: () => number;
};

/** App の JWT の長さの上限 (10 分)。GitHub の決まり */
const APP_JWT_MAX_S = 600;
/** 1 時間の鍵の長さ */
const TOKEN_MS = 60 * 60_000;

/**
 * 代わりの GitHub を作る
 * @param options 時刻
 * @returns Hono、届いた要求、返事を置く set、作った App とインストールと鍵
 */
export function createFakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const now = options.now ?? (() => Date.now());
  const routes = new Map<string, unknown>();
  const requests: GitHubRequest[] = [];
  const apps = new Map<number, FakeApp>();
  const codes = new Map<string, { appId: number; pem: string }>();
  const installations = new Map<number, { appId: number; repos: string[] }>();
  const tokens = new Map<string, FakeToken>();
  const visibility = new Map<string, boolean>();
  const pick: FakeGitHub["pick"] = [
    { fullName: "example/knowidea-ui", private: false },
    { fullName: "example/know-office", private: false },
  ];
  let serial = 0;
  const next = () => {
    serial += 1;
    return serial;
  };

  /**
   * 届いた要求を並べる
   * @param route 「メソッド パス」
   * @param body 本文の文字
   * @param token 付いていた鍵
   */
  const remember = (route: string, body: string, token: string | null) => {
    let parsed: unknown = null;
    try {
      parsed = body ? z.unknown().parse(JSON.parse(body)) : null;
    } catch {
      parsed = null;
    }
    requests.push({ route, body: parsed, token });
  };

  /**
   * App の JWT を確かめ、その App を返す。GitHub と同じく RS256、iss は App ID、長さは 10 分まで
   * @param header Authorization の値
   * @returns App。確かめられなければ null
   */
  const appOf = async (header: string | undefined): Promise<FakeApp | null> => {
    const jwt = /^Bearer (.+)$/.exec(header ?? "")?.[1];
    if (!jwt) return null;
    try {
      const app = apps.get(Number(decodeJwt(jwt).iss));
      if (!app) return null;
      const { payload } = await jwtVerify(jwt, app.publicKey, { algorithms: ["RS256"], issuer: String(app.id), currentDate: new Date(now()) });
      if (payload.iat === undefined || payload.exp === undefined || payload.exp - payload.iat > APP_JWT_MAX_S) return null;
      return app;
    } catch {
      return null;
    }
  };

  /**
   * 1 時間の鍵を読み、切れていない時だけ返す
   * @param token 鍵
   * @returns 鍵の中身。知らない、切れた、インストールが外れた時は null
   */
  const live = (token: string): FakeToken | null => {
    const t = tokens.get(token);
    if (!t || t.expiresAt <= now() || !installations.has(t.installationId)) return null;
    return t;
  };

  /**
   * 鍵がリポジトリに届き、権限を持つか
   * @param t 鍵
   * @param repo owner/name
   * @param need 要る権限。無ければ届くかだけを見る
   * @returns 届けば true
   */
  const reaches = (t: FakeToken, repo: string, need?: { name: string; level: "read" | "write" }): boolean => {
    const repos = t.repos ?? installations.get(t.installationId)?.repos ?? [];
    if (!repos.includes(repo)) return false;
    if (!need) return true;
    const has = t.permissions[need.name];
    return has === "write" || has === need.level;
  };

  const app = new Hono()
    .post("/__fake/routes", async (c) => {
      const { route, body } = FakeRoute.parse(await c.req.json());
      routes.set(route, body);
      return c.body(null, 204);
    })
    .get("/__fake/requests", (c) => c.json(requests))
    // 画面: オーナーが「作成」を押すと App ができ、manifest の redirect_url に code と state を付けて戻す
    .post("/web/settings/apps/new", async (c) => {
      const form = await c.req.parseBody();
      const raw = form["manifest"];
      const manifest = Manifest.parse(JSON.parse(typeof raw === "string" ? raw : ""));
      const id = next();
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      // GitHub は PKCS#1 の PEM で秘密鍵を渡す
      const pem = privateKey.export({ type: "pkcs1", format: "pem" });
      apps.set(id, { id, slug: `${manifest.name.toLowerCase()}-${String(id)}`, manifest, webhookSecret: `whsec-${String(id)}-${crypto.randomUUID()}`, publicKey });
      const code = `code${String(id)}${crypto.randomUUID().replaceAll("-", "")}`;
      codes.set(code, { appId: id, pem });
      const url = new URL(manifest.redirect_url);
      url.searchParams.set("code", code);
      url.searchParams.set("state", c.req.query("state") ?? "");
      return c.redirect(url.toString(), 302);
    })
    // 画面: オーナーが「インストール」を押すと、pick のリポジトリに入れ、setup_url に installation_id を付けて戻す
    .get("/web/apps/:slug/installations/new", (c) => {
      const found = [...apps.values()].find((a) => a.slug === c.req.param("slug"));
      if (!found) return c.text("Not Found", 404);
      const id = 1000 + next();
      installations.set(id, { appId: found.id, repos: pick.map((p) => p.fullName) });
      for (const p of pick) visibility.set(p.fullName, p.private);
      const url = new URL(found.manifest.setup_url);
      url.searchParams.set("installation_id", String(id));
      url.searchParams.set("setup_action", "install");
      return c.redirect(url.toString(), 302);
    })
    // code は 1 度だけ鍵に替えられる。鍵は要らない
    .post("/app-manifests/:code/conversions", (c) => {
      remember(`POST /app-manifests/${c.req.param("code")}/conversions`, "", null);
      const found = codes.get(c.req.param("code"));
      if (!found) return c.json({ message: "Not Found" }, 404);
      codes.delete(c.req.param("code"));
      const a = apps.get(found.appId);
      if (!a) return c.json({ message: "Not Found" }, 404);
      return c.json(
        { id: a.id, slug: a.slug, node_id: `A_${String(a.id)}`, name: a.manifest.name, owner: { login: "example" }, client_id: `Iv1.${String(a.id)}`, client_secret: "cs", webhook_secret: a.webhookSecret, pem: found.pem, html_url: `https://github.com/apps/${a.slug}` },
        201,
      );
    })
    .get("/app/installations/:id", async (c) => {
      remember(`GET /app/installations/${c.req.param("id")}`, "", null);
      const a = await appOf(c.req.header("authorization"));
      if (!a) return c.json({ message: "A JSON web token could not be decoded" }, 401);
      const id = Number(c.req.param("id"));
      const inst = installations.get(id);
      // GitHub はほかの App のインストールを 404 で隠す
      if (inst?.appId !== a.id) return c.json({ message: "Not Found" }, 404);
      return c.json({ id, app_id: a.id, account: { login: "example" }, repository_selection: "selected" });
    })
    .post("/app/installations/:id/access_tokens", async (c) => {
      const text = await c.req.text();
      remember(`POST /app/installations/${c.req.param("id")}/access_tokens`, text, null);
      const a = await appOf(c.req.header("authorization"));
      if (!a) return c.json({ message: "A JSON web token could not be decoded" }, 401);
      const id = Number(c.req.param("id"));
      const inst = installations.get(id);
      if (inst?.appId !== a.id) return c.json({ message: "Not Found" }, 404);
      const input = TokenRequest.safeParse(text ? JSON.parse(text) : {});
      if (!input.success) return c.json({ message: "Invalid request" }, 422);
      const owner = inst.repos[0]?.split("/")[0] ?? "";
      const repos = input.data.repositories?.map((name) => `${owner}/${name}`) ?? null;
      if (repos?.some((r) => !inst.repos.includes(r))) return c.json({ message: "There is at least one repository that does not exist or is not accessible" }, 422);
      const granted = a.manifest.default_permissions;
      const permissions = input.data.permissions ?? granted;
      for (const [name, level] of Object.entries(permissions)) {
        const has = granted[name];
        if (has === undefined || (level === "write" && has !== "write")) return c.json({ message: `The permissions requested are not granted to this installation: ${name}` }, 422);
      }
      const token = `ghs_fake${String(next())}${crypto.randomUUID().replaceAll("-", "")}`;
      const expiresAt = now() + TOKEN_MS;
      tokens.set(token, { installationId: id, repos, permissions, expiresAt });
      return c.json(
        {
          token,
          expires_at: new Date(expiresAt).toISOString(),
          permissions,
          repository_selection: repos === null ? "all" : "selected",
          ...(repos === null ? {} : { repositories: repos.map((r) => ({ full_name: r, name: r.split("/")[1], private: visibility.get(r) ?? false })) }),
        },
        201,
      );
    })
    .get("/installation/repositories", (c) => {
      const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
      remember("GET /installation/repositories", "", token);
      const t = live(token);
      if (!t) return c.json({ message: "Bad credentials" }, 401);
      const all = (installations.get(t.installationId)?.repos ?? []).filter((r) => reaches(t, r));
      const perPage = Number(c.req.query("per_page") ?? "30");
      const page = Number(c.req.query("page") ?? "1");
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return c.json({ total_count: all.length, repositories: slice.map((r) => ({ full_name: r, name: r.split("/")[1], private: visibility.get(r) ?? false })) });
    })
    // git の受け口。Basic の合言葉に 1 時間の鍵を入れる (x-access-token)
    .all("/git/:owner/:name/*", async (c) => {
      const route = `${c.req.method} ${c.req.path.slice("/git".length)}`;
      const basic = /^Basic (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      const [user, token = ""] = basic ? atob(basic).split(":") : [];
      requests.push({ route, body: null, token: token || null });
      await c.req.arrayBuffer();
      const t = user === "x-access-token" ? live(token) : null;
      if (!t) return c.text("Authentication failed", 401);
      const repo = `${c.req.param("owner")}/${c.req.param("name").replace(/\.git$/, "")}`;
      const push = c.req.path.endsWith("/git-receive-pack") || c.req.query("service") === "git-receive-pack";
      if (!reaches(t, repo, { name: "contents", level: push ? "write" : "read" })) return c.text("Permission denied", 403);
      return c.body("fake-git", 200, { "content-type": `application/x-${push ? "git-receive-pack" : "git-upload-pack"}-result` });
    })
    .all("*", async (c) => {
      const header = c.req.header("authorization");
      if (!header) return c.json({ message: "Requires authentication" }, 401);
      const route = `${c.req.method} ${c.req.path}`;
      const token = /^Bearer (.+)$/.exec(header)?.[1] ?? null;
      remember(route, await c.req.text(), token);
      // 代わりの GitHub が出した鍵は、届くリポジトリと期限を確かめる。テストが手で渡す鍵はそのまま通す
      if (token?.startsWith("ghs_fake")) {
        const t = live(token);
        if (!t) return c.json({ message: "Bad credentials" }, 401);
        const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(c.req.path)?.[1];
        if (repo !== undefined && !reaches(t, repo)) return c.json({ message: "Not Found" }, 404);
      }
      if (/^POST \/app\/installations\/\d+\/access_tokens$/.test(route)) {
        return c.json({ token: `ghs_test${String(next())}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      if (!routes.has(route)) return c.json({ message: "Not Found" }, 404);
      return c.json(routes.get(route));
    });

  const set = (route: string, body: unknown): void => {
    if (body === undefined) routes.delete(route);
    else routes.set(route, body);
  };
  const uninstall = (installationId: number): void => {
    installations.delete(installationId);
  };
  return { app, requests, set, apps, installations, tokens, pick, uninstall };
}

/**
 * GitHub の配信 ID と同じ、時刻の入った UUID (版 1) を作る。RFC 9562 の 5.1
 * @param at 時刻 (協定世界時のミリ秒)
 * @returns 配信 ID
 */
export function deliveryId(at: number): string {
  // 1582-10-15 からの 100 ナノ秒の数
  const ticks = BigInt(at) * 10_000n + 0x01b21dd213814000n;
  const low = (ticks & 0xffffffffn).toString(16).padStart(8, "0");
  const mid = ((ticks >> 32n) & 0xffffn).toString(16).padStart(4, "0");
  const high = (((ticks >> 48n) & 0x0fffn) | 0x1000n).toString(16).padStart(4, "0");
  const rest = crypto.getRandomValues(new Uint8Array(8));
  rest[0] = ((rest[0] ?? 0) & 0x3f) | 0x80;
  const hex = [...rest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${low}-${mid}-${high}-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** 代わりの GitHub が送る通知 */
export type WebhookOptions = {
  /** 送り先 */
  url: string;
  /** X-GitHub-Event の値 */
  event: string;
  /** 本文 */
  payload: unknown;
  /** 署名の鍵 */
  secret: string;
  /** X-GitHub-Delivery の値。無ければ今の時刻の配信 ID */
  delivery?: string;
  /** 送る関数。初期値は fetch */
  fetcher?: (req: Request) => Promise<Response>;
};

/**
 * GitHub と同じヘッダーと署名で通知を送る
 * @param options 送り先、種類、本文、署名の鍵
 * @returns 送り先の返事
 */
export function sendWebhook(options: WebhookOptions): Promise<Response> {
  const body = JSON.stringify(options.payload);
  const signature = `sha256=${createHmac("sha256", options.secret).update(body).digest("hex")}`;
  const req = new Request(options.url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event,
      "x-github-delivery": options.delivery ?? deliveryId(Date.now()),
      "x-hub-signature-256": signature,
    },
  });
  return (options.fetcher ?? fetch)(req);
}
