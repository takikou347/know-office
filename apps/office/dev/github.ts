// 開発環境の代わりの GitHub。テストが置いた返事を返し、App の作成とインストール、App の鍵からの絞った鍵、git の受け口、プルリクエストのレビューと行のコメント、Git の API のコミットを GitHub と同じ形で持つ
import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { renewAppKey } from "./github-keys.ts";
import { decodeJwt, jwtVerify } from "jose";
import { z } from "zod";
import { createFakePulls, type FakeActor, type FakePosted, type FakeTreeEntry } from "./github-pulls.ts";
import { type FakeApp, type FakeGitHub, type FakeGitHubOptions, type FakeToken, type GitHubRequest, Manifest, Permission } from "./github-types.ts";

export type { FakeApp, FakeGitHub, FakeGitHubOptions, FakeToken, GitHubRequest } from "./github-types.ts";

const FakeRoute = z.object({ route: z.string(), body: z.unknown() });

const TokenRequest = z.object({ repositories: z.array(z.string()).optional(), permissions: z.record(z.string(), Permission).optional() }).strict();

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
  const gitBodies: FakeGitHub["gitBodies"] = [];
  const revoked: string[] = [];
  const defaultBranches = new Map<string, string>();
  const state = { gitStatus: null as number | null, nextMint: null as FakeGitHub["nextMint"] };
  const visibility = new Map<string, boolean>();
  const sent: FakeGitHub["sent"] = [];
  const failures = new Map<string, number>();
  const heads = new Map<string, string>();
  const trees = new Map<string, FakeTreeEntry[]>();
  const posted: FakePosted = { reviews: [], comments: [] };
  const pick: FakeGitHub["pick"] = [
    { fullName: "example/knowidea-ui", private: false },
    { fullName: "example/know-office", private: false },
  ];
  let serial = 0;
  const next = () => (serial += 1);

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

  /**
   * 鍵から、GitHub で操作した者を決める。代わりの GitHub が出した鍵は App のボット、テストが手で渡す鍵は鍵ごとの者
   * @param token 鍵
   * @returns 者の印と、通知に載るログイン名
   */
  const actorOf = (token: string | null): FakeActor => {
    const t = token === null ? undefined : tokens.get(token);
    const a = t ? apps.get(installations.get(t.installationId)?.appId ?? 0) : undefined;
    if (a) return { key: `app:${String(a.id)}`, login: `${a.slug}[bot]` };
    return { key: `token:${token ?? ""}`, login: "test-app[bot]" };
  };

  /**
   * 鍵がリポジトリへの権限を持つか。テストが手で渡す鍵は、鍵の出し手の側で権限を確かめるので通す
   * @param token 鍵
   * @param repo owner/name
   * @param name 権限の名前
   * @param level 読むか書くか
   * @returns 持てば true
   */
  const allows = (token: string | null, repo: string, name: string, level: "read" | "write"): boolean => {
    if (!token?.startsWith("ghs_fake")) return true;
    const t = live(token);
    return t !== null && reaches(t, repo, { name, level });
  };

  const pulls = createFakePulls({ actorOf, allows, installationOf: (token) => tokens.get(token ?? "")?.installationId ?? 0, next, sent, heads, trees, posted });

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
      const over = state.nextMint;
      state.nextMint = null;
      return c.json(
        {
          token,
          expires_at: new Date(expiresAt).toISOString(),
          permissions,
          repository_selection: repos === null ? "all" : "selected",
          ...(repos === null ? {} : { repositories: repos.map((r) => ({ full_name: r, name: r.split("/")[1], private: visibility.get(r) ?? false })) }),
          ...over,
        },
        201,
      );
    })
    // 1 時間の鍵を期限の前に取り消す
    .delete("/installation/token", (c) => {
      const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
      remember("DELETE /installation/token", "", token);
      if (!live(token)) return c.json({ message: "Bad credentials" }, 401);
      tokens.delete(token);
      revoked.push(token);
      return c.body(null, 204);
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
      // 大きな push も読み切れるよう、ためずに数える
      let bytes = 0;
      const reader = c.req.raw.body?.getReader();
      for (;;) {
        const chunk = reader ? await reader.read() : { done: true as const, value: undefined };
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
      }
      gitBodies.push({ route, bytes, encoding: c.req.header("content-encoding") ?? null });
      if (state.gitStatus !== null) {
        const status = state.gitStatus;
        state.gitStatus = null;
        return new Response("fake failure", { status });
      }
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
      const text = await c.req.text();
      remember(route, text, token);
      // 代わりの GitHub が出した鍵は、届くリポジトリと期限を確かめる。テストが手で渡す鍵はそのまま通す
      if (token?.startsWith("ghs_fake")) {
        const t = live(token);
        if (!t) return c.json({ message: "Bad credentials" }, 401);
        const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(c.req.path)?.[1];
        if (repo !== undefined && !reaches(t, repo)) return c.json({ message: "Not Found" }, 404);
      }
      // 入れたリポジトリの情報は、置いた返事が無ければ公開か非公開と既定のブランチを返す
      const info = /^GET \/repos\/([^/]+\/[^/]+)$/.exec(route)?.[1];
      if (info !== undefined && !routes.has(route) && visibility.has(info)) {
        return c.json({ full_name: info, private: visibility.get(info) ?? false, default_branch: defaultBranches.get(info) ?? "main" });
      }
      if (/^POST \/app\/installations\/\d+\/access_tokens$/.test(route)) {
        return c.json({ token: `ghs_test${String(next())}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      const failure = failures.get(route);
      if (failure !== undefined) {
        failures.delete(route);
        return new Response(JSON.stringify({ message: "fake failure" }), { status: failure, headers: { "content-type": "application/json" } });
      }
      if (!routes.has(route)) return pulls.answer(route, text, token) ?? c.json({ message: "Not Found" }, 404);
      const body = routes.get(route);
      // 出したプルリクエストは、出した者を覚える。自分で可を付ける事を断るのに使う
      const opened = /^POST \/repos\/([^/]+\/[^/]+)\/pulls$/.exec(route)?.[1];
      const number = z.object({ number: z.number() }).loose().safeParse(body);
      if (opened !== undefined && number.success) pulls.opened(opened, number.data.number, token);
      return c.json(body);
    });

  const set = (route: string, body: unknown): void => {
    if (body === undefined) routes.delete(route);
    else routes.set(route, body);
  };
  return {
    app,
    requests,
    gitBodies,
    get gitStatus() {
      return state.gitStatus;
    },
    set gitStatus(v) {
      state.gitStatus = v;
    },
    get nextMint() {
      return state.nextMint;
    },
    set nextMint(v) {
      state.nextMint = v;
    },
    revoked,
    defaultBranches,
    set,
    apps,
    installations,
    tokens,
    pick,
    uninstall: (installationId: number): void => void installations.delete(installationId),
    newPrivateKey: (appId: number): string => renewAppKey(apps.get(appId)),
    sent,
    failNext: (route: string, status: number): void => void failures.set(route, status),
    heads,
    trees,
    posted,
  };
}
