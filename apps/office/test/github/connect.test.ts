// GitHub App の連携。ボタン 1 つで App を作って入れ、外されたら連携を切る (タスクとレビューの 3.2)
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MINUTE, rows, useWork } from "../helpers/work.ts";
import { isRedirect } from "../../src/gate/github/app.ts";
import { browse, connect, createGitHubApp, FAKES, hook, onGitHub, returnFromGitHub, stepUp, urlOf, wrapDb } from "../helpers/github.ts";

const world = useWork();

const Problem = z.object({ code: z.string() }).loose();

/**
 * vault のまだ使える行を名前ごとに数える
 * @returns 名前から行の数
 */
async function liveVault(): Promise<Record<string, number>> {
  const found = await rows(world.d1.DB, "SELECT name, COUNT(*) AS n FROM vault WHERE revoked_at IS NULL AND name LIKE 'github_%' GROUP BY name");
  return Object.fromEntries(found.map((r) => [String(r["name"]), Number(r["n"])]));
}

/**
 * 監査ログの操作を並べる
 * @returns GitHub の連携の操作
 */
function githubAudits(): string[] {
  return world.gate.audits.map((a) => a.action).filter((a) => a.startsWith("github."));
}

/**
 * 代わりの GitHub への要求が GET /app かを見る
 * @param input 要求
 * @returns GET /app なら true
 */
function isAppRoute(input: Parameters<typeof urlOf>[0]): boolean {
  return (urlOf(input).split("?")[0] ?? "").endsWith("/app");
}

describe("ボタン 1 つで連携する", () => {
  it("連携する", async () => {
    await stepUp(world);
    const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
    expect(res.status).toBe(200);
    const data = z.object({ data: z.object({ action: z.string(), manifest: z.record(z.string(), z.unknown()), state: z.string() }) }).parse(await res.json()).data;
    expect(data.action).toBe(`${FAKES}/github/web/settings/apps/new?state=${data.state}`);
    // 非公開で、workflows の権限を持たない
    expect(data.manifest).toMatchObject({
      public: false,
      url: "http://localhost",
      redirect_url: "http://localhost/api/v1/github/callback",
      setup_url: "http://localhost/api/v1/github/installed",
      hook_attributes: { url: "http://localhost/hooks/v1/github", active: true },
    });
    // 戻しの rollback.yml を動かす actions の書きと、deployment_status を受ける deployments の読みを持つ
    expect(data.manifest["default_permissions"]).toEqual({ contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "write", administration: "write", metadata: "read", actions: "write", deployments: "read" });
    expect(data.manifest["default_events"]).toEqual(expect.arrayContaining(["push", "deployment_status", "workflow_run"]));
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(data.manifest["default_permissions"]))).not.toContain("workflows");

    // GitHub の画面で「作成」を押す
    const made = await onGitHub(world, data.action, { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(data.manifest) }) });
    const toInstall = await returnFromGitHub(world, made.headers.get("location") ?? "");
    expect(toInstall.status).toBe(302);
    const app = [...world.gate.github.apps.values()][0];
    expect(toInstall.headers.get("location")).toBe(`${FAKES}/github/web/apps/${app?.slug ?? ""}/installations/new`);
    // GitHub の画面で「インストール」を押す
    const installed = await onGitHub(world, toInstall.headers.get("location") ?? "");
    const done = await returnFromGitHub(world, installed.headers.get("location") ?? "");
    expect({ status: done.status, location: done.headers.get("location") }).toEqual({ status: 302, location: "/settings" });

    const repos = await browse(world, "/api/v1/github/repos");
    expect(await repos.json()).toMatchObject({ data: [{ fullName: "example/knowidea-ui", private: false }, { fullName: "example/know-office", private: false }], meta: { next: null } });
    // 元の鍵は暗号にして置き、平文を残さない
    expect(await liveVault()).toEqual({ github_app: 1, github_installation: 1 });
    const stored = await rows(world.d1.DB, "SELECT ciphertext FROM vault WHERE name = 'github_app'");
    expect(JSON.stringify(stored)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(stored)).not.toContain(app?.webhookSecret ?? "");
    expect(githubAudits()).toEqual(["github.app_created", "github.installed"]);
    expect(JSON.stringify(world.gate.audits)).not.toContain(app?.webhookSecret ?? "");
  });

  it("やめる", async () => {
    const { installationId, webhookSecret } = await connect(world);
    world.gate.github.uninstall(installationId);
    const res = await hook(world, { event: "installation", payload: { action: "deleted", installation: { id: installationId } }, secret: webhookSecret });
    expect(res.status).toBe(204);
    // 外された App の元の鍵も使わない。もう一度連携する時は新しい App を作る
    expect(await liveVault()).toEqual({});
    const repos = await browse(world, "/api/v1/github/repos");
    expect({ status: repos.status, body: Problem.parse(await repos.json()).code }).toEqual({ status: 502, body: "upstream_failed" });
    expect(githubAudits()).toContain("github.uninstalled");
  });

  it("通知が届かなくても、鍵を作る時の 404 で連携を切る", async () => {
    const { installationId } = await connect(world);
    world.gate.github.uninstall(installationId);
    expect((await browse(world, "/api/v1/github/repos")).status).toBe(502);
    expect(await liveVault()).toEqual({});
    expect(githubAudits()).toEqual(["github.app_created", "github.installed", "github.uninstalled"]);
  });

  it("外した後にもう一度連携できる", async () => {
    const { installationId, webhookSecret } = await connect(world);
    world.gate.github.uninstall(installationId);
    await hook(world, { event: "installation", payload: { action: "deleted", installation: { id: installationId } }, secret: webhookSecret });
    await connect(world);
    expect(await liveVault()).toEqual({ github_app: 1, github_installation: 1 });
    expect((await browse(world, "/api/v1/github/repos")).status).toBe(200);
  });

  it("連携を始めるにはパスキーの確認が要る", async () => {
    const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 401, code: "step_up_required" });
  });

  it("App を作ってインストールしないまま離れても、もう一度押すとインストール先が返り、App を作り直さない", async () => {
    await stepUp(world);
    expect((await returnFromGitHub(world, await createGitHubApp(world))).status).toBe(302);
    const slug = [...world.gate.github.apps.values()][0]?.slug ?? "";
    const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
    expect(res.status).toBe(200);
    const data = z.object({ data: z.unknown() }).parse(await res.json()).data;
    expect(data).toEqual({ action: `${FAKES}/github/web/apps/${slug}/installations/new`, manifest: null, state: null });
    expect(world.gate.github.apps.size).toBe(1);
    expect(await liveVault()).toEqual({ github_app: 1 });
    // 返ったインストール先から入れれば、つながる
    const installed = await onGitHub(world, `${FAKES}/github/web/apps/${slug}/installations/new`);
    expect((await returnFromGitHub(world, installed.headers.get("location") ?? "")).status).toBe(302);
    expect(await liveVault()).toEqual({ github_app: 1, github_installation: 1 });
  });

  it("鍵を作る時の 404 で、App の鍵の版が読んだ後に進んでいても、片方だけ残さない", async () => {
    const { installationId } = await connect(world);
    world.gate.github.uninstall(installationId);
    // 読んだ後、取り消す前に App の鍵の版が進む
    const real = world.gate.github.app.request.bind(world.gate.github.app);
    const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) => {
      if (urlOf(input).includes("/access_tokens")) {
        await world.d1.DB.batch([
          world.d1.DB.prepare("INSERT INTO vault (name, ciphertext, iv, version, created_at) SELECT name, ciphertext, iv, version + 1, created_at FROM vault WHERE name = 'github_app' AND revoked_at IS NULL"),
          world.d1.DB.prepare("UPDATE vault SET revoked_at = 1 WHERE name = 'github_app' AND revoked_at IS NULL AND version < (SELECT MAX(version) FROM vault WHERE name = 'github_app')"),
        ]);
      }
      return real(input, init, ...rest);
    });
    expect((await browse(world, "/api/v1/github/repos")).status).toBe(502);
    spy.mockRestore();
    expect(await liveVault()).toEqual({});
  });

  it("GitHub が 3xx を返したら追わずに 502", async () => {
    await connect(world);
    const real = world.gate.github.app.request.bind(world.gate.github.app);
    const seen: (string | undefined)[] = [];
    const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) => {
      if (!urlOf(input).includes("/installation/repositories")) return real(input, init, ...rest);
      seen.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    });
    const res = await browse(world, "/api/v1/github/repos");
    spy.mockRestore();
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
    expect(seen).toEqual(["manual"]);
  });

  it("作った App を GitHub で消してインストールしていない時は、App の鍵を取り消し、新しい App の作り方を返す", async () => {
    await stepUp(world);
    expect((await returnFromGitHub(world, await createGitHubApp(world))).status).toBe(302);
    const gone = [...world.gate.github.apps.keys()][0] ?? 0;
    world.gate.github.apps.delete(gone);
    const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
    expect(res.status).toBe(200);
    const data = z.object({ data: z.object({ action: z.string(), manifest: z.record(z.string(), z.unknown()), state: z.string() }) }).parse(await res.json()).data;
    expect(data.action).toBe(`${FAKES}/github/web/settings/apps/new?state=${data.state}`);
    expect(await liveVault()).toEqual({});
    expect(githubAudits()).toEqual(["github.app_created", "github.app_gone"]);
    // 返った作り方から作り直してつなげる
    const made = await onGitHub(world, data.action, { method: "POST", body: new URLSearchParams({ manifest: JSON.stringify(data.manifest) }) });
    const toInstall = await returnFromGitHub(world, made.headers.get("location") ?? "");
    const installed = await onGitHub(world, toInstall.headers.get("location") ?? "");
    expect((await returnFromGitHub(world, installed.headers.get("location") ?? "")).status).toBe(302);
    expect(await liveVault()).toEqual({ github_app: 1, github_installation: 1 });
  });

  it("消えた App の取り消しと同時にインストールが入ったら、インストールを残して 409", async () => {
    await stepUp(world);
    expect((await returnFromGitHub(world, await createGitHubApp(world))).status).toBe(302);
    const slug = [...world.gate.github.apps.values()][0]?.slug ?? "";
    const real = world.gate.github.app.request.bind(world.gate.github.app);
    // GitHub が 404 を返す前に、同じ App のインストールが戻ってくる
    const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) => {
      if (!isAppRoute(input)) return real(input, init, ...rest);
      spy.mockRestore();
      const installed = await onGitHub(world, `${FAKES}/github/web/apps/${slug}/installations/new`);
      expect((await returnFromGitHub(world, installed.headers.get("location") ?? "")).status).toBe(302);
      return new Response(JSON.stringify({ message: "Integration not found" }), { status: 404 });
    });
    const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
    spy.mockRestore();
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 409, code: "conflict" });
    expect(await liveVault()).toEqual({ github_app: 1, github_installation: 1 });
    expect(githubAudits()).not.toContain("github.app_gone");
  });

  it("GET /app が 401 や 500 なら App を取り消さず 502", async () => {
    await stepUp(world);
    expect((await returnFromGitHub(world, await createGitHubApp(world))).status).toBe(302);
    for (const status of [401, 500]) {
      const real = world.gate.github.app.request.bind(world.gate.github.app);
      const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) =>
        isAppRoute(input) ? new Response(JSON.stringify({ message: "x" }), { status }) : real(input, init, ...rest),
      );
      const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
      spy.mockRestore();
      expect({ status, res: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status, res: 502, code: "upstream_failed" });
    }
    expect(await liveVault()).toEqual({ github_app: 1 });
  });

  it("304 はリダイレクトとして扱わず、GitHub の失敗として 502", async () => {
    for (const status of [301, 302, 303, 307, 308]) expect({ status, redirect: isRedirect(new Response(null, { status })) }).toEqual({ status, redirect: true });
    expect(isRedirect(new Response(null, { status: 304 }))).toBe(false);
    await connect(world);
    const real = world.gate.github.app.request.bind(world.gate.github.app);
    const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) =>
      urlOf(input).includes("/installation/repositories") ? new Response(null, { status: 304 }) : real(input, init, ...rest),
    );
    const res = await browse(world, "/api/v1/github/repos");
    spy.mockRestore();
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
  });

  it("連携した後にもう一度押すと 409", async () => {
    await connect(world);
    const res = await world.gate.request("/api/v1/github/connect", { method: "POST", headers: world.headers });
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 409, code: "conflict" });
  });

  it("state はちょうど 10 分で切れる", async () => {
    await stepUp(world);
    const early = await createGitHubApp(world);
    const late = await createGitHubApp(world);
    world.clock.advance(10 * MINUTE - 1);
    expect((await returnFromGitHub(world, early)).status).toBe(302);
    world.clock.advance(1);
    // 1 つ目で App を置いたので、ここで 409 にならないよう外してから確かめる
    await world.d1.DB.prepare("DELETE FROM vault WHERE name = 'github_app'").run();
    const res = await returnFromGitHub(world, late);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "forbidden" });
  });

  it("書き換えた state と形の違う code は断る", async () => {
    await stepUp(world);
    const url = new URL(await createGitHubApp(world));
    const state = url.searchParams.get("state") ?? "";
    const forged = new URL(url);
    forged.searchParams.set("state", `${state.slice(0, -2)}${state.endsWith("AA") ? "BB" : "AA"}`);
    expect((await returnFromGitHub(world, forged.toString())).status).toBe(403);
    const odd = new URL(url);
    odd.searchParams.set("code", "../../app/installations");
    expect((await returnFromGitHub(world, odd.toString())).status).toBe(422);
    expect(world.gate.github.requests.filter((r) => r.route.includes("conversions"))).toEqual([]);
    expect(await liveVault()).toEqual({});
  });

  it("state は 1 度しか使えない", async () => {
    await stepUp(world);
    const url = await createGitHubApp(world);
    expect((await returnFromGitHub(world, url)).status).toBe(302);
    // App の鍵を外しても、同じ state ではもう進めない
    await world.d1.DB.prepare("DELETE FROM vault WHERE name = 'github_app'").run();
    const conversions = () => world.gate.github.requests.filter((r) => r.route.includes("conversions")).length;
    const before = conversions();
    const again = await returnFromGitHub(world, url);
    expect({ status: again.status, code: Problem.parse(await again.json()).code }).toEqual({ status: 403, code: "forbidden" });
    expect(conversions()).toBe(before);
  });

  it("App を作ってインストールする前に、別の code で置き換えようとすると 409", async () => {
    await stepUp(world);
    const first = await createGitHubApp(world);
    const second = await createGitHubApp(world);
    expect((await returnFromGitHub(world, first)).status).toBe(302);
    const firstSlug = [...world.gate.github.apps.values()][0]?.slug;
    const conversions = () => world.gate.github.requests.filter((r) => r.route.includes("conversions")).length;
    const before = conversions();
    const res = await returnFromGitHub(world, second);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 409, code: "conflict" });
    // 置き換えない code は App の鍵に替えない
    expect(conversions()).toBe(before);
    expect(await liveVault()).toEqual({ github_app: 1 });
    // 置いたままの App は 1 つ目
    const installed = await onGitHub(world, `${FAKES}/github/web/apps/${firstSlug ?? ""}/installations/new`);
    expect((await returnFromGitHub(world, installed.headers.get("location") ?? "")).status).toBe(302);
  });

  it("同じ時に 2 つ戻ってきても、App の鍵は 1 つだけ置く", async () => {
    await stepUp(world);
    const first = await createGitHubApp(world);
    const second = await createGitHubApp(world);
    // 1 つ目が vault に書く直前に、2 つ目を最後まで通す
    const held: { second: Promise<Response> | null } = { second: null };
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        if (held.second === null) {
          held.second = returnFromGitHub(world, second);
          await held.second;
        }
        return real(statements);
      },
    });
    const one = await returnFromGitHub(world, first);
    restore();
    const other = await (held.second ?? Promise.reject(new Error("2 つ目が走っていない")));
    expect([one.status, other.status].toSorted((a, b) => a - b)).toEqual([302, 409]);
    expect(await liveVault()).toEqual({ github_app: 1 });
    expect(githubAudits()).toEqual(["github.app_created"]);
  });

  it("GitHub が code を鍵に替えられなければ何も置かない", async () => {
    await stepUp(world);
    const url = new URL(await createGitHubApp(world));
    url.searchParams.set("code", "unknown-code");
    const res = await returnFromGitHub(world, url.toString());
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
    expect(await liveVault()).toEqual({});
    expect(githubAudits()).toEqual([]);
  });

  it("ほかの App のインストールは 403 で、置かない", async () => {
    await stepUp(world);
    await returnFromGitHub(world, await createGitHubApp(world));
    const res = await returnFromGitHub(world, "/api/v1/github/installed?installation_id=987654&setup_action=install");
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "forbidden" });
    expect(await liveVault()).toEqual({ github_app: 1 });
  });

  it("同じインストールが 2 度戻っても 1 度だけ記録する", async () => {
    const { installationId } = await connect(world);
    const again = await returnFromGitHub(world, `/api/v1/github/installed?installation_id=${String(installationId)}&setup_action=update`);
    expect(again.status).toBe(302);
    expect(await liveVault()).toEqual({ github_app: 1, github_installation: 1 });
    expect(githubAudits()).toEqual(["github.app_created", "github.installed"]);
  });
});
