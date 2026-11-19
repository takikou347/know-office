// サービスの様子。種類ごとに出す項目、knowidea-ui のバージョンのそろい、使う側のバージョンを上げるタスク、手で前のバージョンに戻す (サービスと拡張の 3.2)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resetLedger } from "../helpers/d1.ts";
import { connect, type Connected, hook, stepUp } from "../helpers/github.ts";
import { api, idOf, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

/** 最初に登録した 2 つのサービス (0006_seed_services.sql) */
const UI_ID = "00000000-0000-7000-8000-000000000101";
const OFFICE_ID = "00000000-0000-7000-8000-000000000102";

/** 代わりの GitHub がインストールで選ぶリポジトリ */
const UI_REPO = "example/knowidea-ui";
const OFFICE_REPO = "example/know-office";

/** knowidea-ui の 4 つのパッケージと説明のサイトの package.json */
const UI_MANIFESTS = {
  "packages/tokens/package.json": "knowidea-tokens",
  "packages/css/package.json": "knowidea-css",
  "packages/icons/package.json": "knowidea-icons",
  "packages/ui/package.json": "knowidea-ui",
  "apps/docs/package.json": "@knowidea/docs",
} as const;

const sha = (n: number) => n.toString(16).padStart(40, "0");

const Status = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("library"),
      version: z.string().nullable(),
      packages: z.array(z.object({ name: z.string(), version: z.string() }).strict()),
      aligned: z.boolean(),
      releasedAt: z.string().nullable(),
      publish: z.object({ at: z.string(), passed: z.boolean() }).strict().nullable(),
      usedBy: z.array(z.object({ serviceId: z.string(), name: z.string(), version: z.string(), behind: z.boolean() }).strict()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("web_app"),
      version: z.string().nullable(),
      deployedAt: z.string().nullable(),
      rolledBackAt: z.string().nullable(),
      users: z.number().nullable(),
      errorRate: z.number().nullable(),
      costMicroUsd: z.number(),
    })
    .strict(),
  z.object({ kind: z.literal("content"), published: z.array(z.object({ at: z.string(), title: z.string() }).strict()), reads: z.number().nullable() }).strict(),
]);

/**
 * サービスの詳細から様子を読む
 * @param w テストの物
 * @param serviceId サービス ID
 * @returns 様子
 */
async function statusOf(w: WorkWorld, serviceId: string): Promise<z.infer<typeof Status>> {
  return Status.parse(z.object({ status: z.unknown() }).loose().parse(await api(w, "GET", `/api/v1/services/${serviceId}`)).status);
}

/**
 * GitHub とつなぎ、最初の 2 つのサービスを代わりの GitHub のリポジトリに向ける
 * @param w テストの物
 * @returns 連携した結果
 */
async function linked(w: WorkWorld): Promise<Connected> {
  const done = await connect(w);
  await w.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(UI_REPO, UI_ID).run();
  await w.d1.DB.prepare("UPDATE services SET repo = ? WHERE id = ?").bind(OFFICE_REPO, OFFICE_ID).run();
  return done;
}

/**
 * knowidea-ui の main に push した通知を送る。コミットの package.json は versions のとおり
 * @param w テストの物
 * @param link 連携した結果
 * @param commit コミットの番号
 * @param versions 道ごとのバージョン。無い道は全体の version
 * @param version 全体のバージョン
 * @returns ゲートウェイの返事
 */
function pushUi(w: WorkWorld, link: Connected, commit: number, version: string, versions: Partial<Record<keyof typeof UI_MANIFESTS, string>> = {}): Promise<Response> {
  for (const [path, name] of Object.entries(UI_MANIFESTS)) {
    w.gate.github.contents.set(`${sha(commit)}:${path}`, JSON.stringify({ name, version: Object.entries(versions).find(([p]) => p === path)?.[1] ?? version }));
  }
  return pushTo(w, link, UI_REPO, commit);
}

/**
 * know-office の main に push した通知を送る。apps/office/package.json は knowidea-ui の uiVersion を入れている
 * @param w テストの物
 * @param link 連携した結果
 * @param commit コミットの番号
 * @param uiVersion 入れている knowidea-ui のバージョン
 * @returns ゲートウェイの返事
 */
function pushOffice(w: WorkWorld, link: Connected, commit: number, uiVersion: string): Promise<Response> {
  w.gate.github.contents.set(`${sha(commit)}:package.json`, JSON.stringify({ name: "know-office", private: true }));
  const deps = { "knowidea-css": uiVersion, "knowidea-icons": uiVersion, "knowidea-tokens": uiVersion, "knowidea-ui": uiVersion };
  w.gate.github.contents.set(`${sha(commit)}:apps/office/package.json`, JSON.stringify({ name: "@know-office/office", version: "0.1.0", dependencies: deps }));
  return pushTo(w, link, OFFICE_REPO, commit);
}

/**
 * main への push の通知を送る
 * @param w テストの物
 * @param link 連携した結果
 * @param repo リポジトリ
 * @param commit コミットの番号
 * @param ref 押した先
 * @param extra 通知の本文に足す物
 * @returns ゲートウェイの返事
 */
function pushTo(w: WorkWorld, link: Connected, repo: string, commit: number, ref = "refs/heads/main", extra: Record<string, unknown> = {}): Promise<Response> {
  return hook(w, {
    event: "push",
    secret: link.webhookSecret,
    payload: { ref, before: sha(commit - 1), after: sha(commit), repository: { full_name: repo, default_branch: "main" }, installation: { id: link.installationId }, ...extra },
  });
}

/**
 * 代わりの GitHub が受けた、ファイルを読む要求の数
 * @param w テストの物
 * @returns 数
 */
function contentReads(w: WorkWorld): number {
  return w.gate.github.requests.filter((r) => r.route.includes("/contents/")).length;
}

/**
 * 足した、バージョンを上げるタスク
 * @param w テストの物
 * @returns タスクの行
 */
async function bumpTasks(w: WorkWorld): Promise<Record<string, unknown>[]> {
  return rows(w.d1.DB, "SELECT title, scope, assignee, status, source FROM nodes WHERE source LIKE 'ui-bump:%' ORDER BY source");
}

describe("サービスの種類", () => {
  it("種類で項目が変わる", async () => {
    const link = await linked(world);
    expect((await pushUi(world, link, 1, "0.13.0")).status).toBe(204);
    const library = await statusOf(world, UI_ID);
    expect(library).toMatchObject({ kind: "library", version: "0.13.0", aligned: true });
    expect(library).not.toHaveProperty("users");
    // Web アプリはデプロイ、利用者数、失敗率、費用を出す。記録がまだ無い値は null
    expect(await statusOf(world, OFFICE_ID)).toEqual({ kind: "web_app", version: null, deployedAt: null, rolledBackAt: null, users: null, errorRate: null, costMicroUsd: 0 });
    const blog = idOf(await api(world, "POST", "/api/v1/services", { title: "読み物", kind: "content", aim: "作り方を伝える", users: "作る人", costEstimateMicroUsd: 0, revenueEstimateMicroUsd: 0 }, 201));
    expect(await statusOf(world, blog)).toEqual({ kind: "content", published: [], reads: null });
  });

  it("利用者数は直前 24 時間の訪問の和で、どの行も null なら null", async () => {
    await resetLedger(world.d1.REC_2026);
    const now = world.clock.now();
    const metric = (n: number, ago: number, users: number | null) =>
      world.d1.REC_2026.prepare("INSERT INTO service_metrics (id, service_id, at, requests, errors, users, reads) VALUES (?, ?, ?, 10, 0, ?, NULL)").bind(`00000000-0000-7000-8000-00000000090${String(n)}`, OFFICE_ID, now - ago, users).run();
    // 訪問を数えていない区切りは null で、和に入れない
    await metric(1, 10 * 60_000, null);
    expect(await statusOf(world, OFFICE_ID)).toMatchObject({ users: null });
    // 24 時間ちょうど前の区切りは入れない
    await metric(2, 24 * 60 * 60_000, 100);
    await metric(3, 60 * 60_000, 3);
    await metric(4, 5 * 60_000, 4);
    expect(await statusOf(world, OFFICE_ID)).toMatchObject({ users: 7 });
  });

  it("失敗率は Worker のエラーとアプリの 5xx の和を呼び出しの数で割る", async () => {
    await resetLedger(world.d1.REC_2026);
    const now = world.clock.now();
    const metric = (n: number, serverErrors: number | null) =>
      world.d1.REC_2026.prepare("INSERT INTO service_metrics (id, service_id, at, requests, errors, users, reads, server_errors) VALUES (?, ?, ?, 10, 1, NULL, NULL, ?)").bind(`00000000-0000-7000-8000-00000000091${String(n)}`, OFFICE_ID, now - n * 5 * 60_000, serverErrors).run();
    // 5xx を数える前の行は null で、Worker のエラーだけを数える
    await metric(1, 2);
    await metric(2, null);
    expect(await statusOf(world, OFFICE_ID)).toMatchObject({ errorRate: 0.2 });
  });
});

describe("最初のサービスは knowidea-ui", () => {
  it("バージョンがそろっていない", async () => {
    const link = await linked(world);
    await pushUi(world, link, 1, "0.12.0", { "packages/ui/package.json": "0.13.0" });
    const status = await statusOf(world, UI_ID);
    expect(status).toMatchObject({ kind: "library", aligned: false });
    expect(status.kind === "library" ? status.packages : []).toContainEqual({ name: "knowidea-ui", version: "0.13.0" });
    expect(status.kind === "library" ? status.packages : []).toContainEqual({ name: "knowidea-css", version: "0.12.0" });
  });

  it("バージョンを上げるタスクを作る", async () => {
    const link = await linked(world);
    await pushOffice(world, link, 10, "0.12.1");
    await pushUi(world, link, 1, "0.13.0");
    expect(await statusOf(world, UI_ID)).toMatchObject({ usedBy: [{ serviceId: OFFICE_ID, name: "know-office", version: "0.12.1", behind: true }] });
    expect(await bumpTasks(world)).toEqual([{ title: "knowidea-ui を 0.12.1 から 0.13.0 に上げる", scope: OFFICE_ID, assignee: "builder", status: "todo", source: `ui-bump:${OFFICE_ID}:0.13.0` }]);
    // 同じ通知が送り直されても、同じバージョンの別の push でも、タスクは 1 つ
    await pushUi(world, link, 1, "0.13.0");
    await pushUi(world, link, 2, "0.13.0");
    expect(await bumpTasks(world)).toHaveLength(1);
    expect(await rows(world.d1.DB, "SELECT kind FROM service_events WHERE service_id = ? AND kind = 'release'", UI_ID)).toHaveLength(1);
    // 上げた後は差が無く、新しいタスクも足さない
    await pushOffice(world, link, 11, "0.13.0");
    expect(await statusOf(world, UI_ID)).toMatchObject({ usedBy: [{ serviceId: OFFICE_ID, version: "0.13.0", behind: false }] });
    expect(await bumpTasks(world)).toHaveLength(1);
  });

  it("上がったバージョンごとに 1 つのタスクで、同じ版と下がった版では作らない", async () => {
    const link = await linked(world);
    await pushOffice(world, link, 10, "0.12.1");
    await pushUi(world, link, 1, "0.13.0");
    await pushUi(world, link, 2, "0.14.0");
    await pushUi(world, link, 3, "0.14.0");
    await pushUi(world, link, 4, "0.12.0");
    expect((await bumpTasks(world)).map((t) => t["source"])).toEqual([`ui-bump:${OFFICE_ID}:0.13.0`, `ui-bump:${OFFICE_ID}:0.14.0`]);
    expect(await rows(world.d1.DB, "SELECT json_extract(detail, '$.version') AS version FROM service_events WHERE service_id = ? AND kind = 'release' ORDER BY at, rowid", UI_ID)).toEqual([{ version: "0.13.0" }, { version: "0.14.0" }]);
    expect(await statusOf(world, UI_ID)).toMatchObject({ version: "0.14.0" });
  });

  it("終えたタスクの後に同じ版が届いても作らない", async () => {
    const link = await linked(world);
    await pushOffice(world, link, 10, "0.12.1");
    await pushUi(world, link, 1, "0.13.0");
    await world.d1.DB.prepare("UPDATE nodes SET status = 'done' WHERE source LIKE 'ui-bump:%'").run();
    await world.d1.DB.prepare("DELETE FROM github_deliveries").run();
    await pushUi(world, link, 1, "0.13.0");
    expect(await bumpTasks(world)).toHaveLength(1);
  });

  it("公開の後に know-office の push で古い版が分かっても、タスクを 1 つ作る", async () => {
    const link = await linked(world);
    await pushUi(world, link, 1, "0.13.0");
    await pushOffice(world, link, 10, "0.12.1");
    await pushOffice(world, link, 11, "0.12.2");
    expect((await bumpTasks(world)).map((t) => t["source"])).toEqual([`ui-bump:${OFFICE_ID}:0.13.0`]);
    expect(await statusOf(world, UI_ID)).toMatchObject({ usedBy: [{ serviceId: OFFICE_ID, version: "0.12.2", behind: true }] });
  });

  it("使う版をまだ読んでいないサービスに公開が先に届くと、既定のブランチの package.json を読んでタスクを 1 つ作る", async () => {
    const link = await linked(world);
    // 代わりの GitHub は、既定のブランチの先をどのリポジトリでも b の 40 桁で返す
    const deps = { "knowidea-css": "0.12.1", "knowidea-icons": "0.12.1", "knowidea-tokens": "0.12.1", "knowidea-ui": "0.12.1" };
    world.gate.github.contents.set(`${"b".repeat(40)}:apps/office/package.json`, JSON.stringify({ name: "@know-office/office", dependencies: deps }));
    await pushUi(world, link, 1, "0.13.0");
    await pushUi(world, link, 2, "0.13.0");
    expect((await bumpTasks(world)).map((t) => t["source"])).toEqual([`ui-bump:${OFFICE_ID}:0.13.0`]);
    expect(await statusOf(world, UI_ID)).toMatchObject({ usedBy: [{ serviceId: OFFICE_ID, version: "0.12.1", behind: true }] });
  });

  it("公開の時に使う側を読めなくても、公開は 1 つ残り、エラーログに残して落ちない", async () => {
    const link = await linked(world);
    // 既定のブランチの先のコミットを読む問いを落とす
    world.gate.github.failNext(`GET /repos/${OFFICE_REPO}/git/ref/heads/main`, 500);
    expect((await pushUi(world, link, 1, "0.13.0")).status).toBe(204);
    expect(await rows(world.d1.DB, "SELECT id FROM service_events WHERE service_id = ? AND kind = 'release'", UI_ID)).toHaveLength(1);
    expect(await rows(world.d1.REC_2026, "SELECT level FROM error_events WHERE code = 'service_uses_unread'")).toEqual([{ level: "warn" }]);
    expect(await bumpTasks(world)).toEqual([]);
  });

  it("同じ版を同時に 2 つ push しても、公開は 1 つ", async () => {
    const link = await linked(world);
    for (const n of [1, 2]) for (const [path, name] of Object.entries(UI_MANIFESTS)) world.gate.github.contents.set(`${sha(n)}:${path}`, JSON.stringify({ name, version: "0.13.0" }));
    const answers = await Promise.all([pushTo(world, link, UI_REPO, 1), pushTo(world, link, UI_REPO, 2)]);
    expect(answers.map((a) => a.status)).toEqual([204, 204]);
    expect(await rows(world.d1.DB, "SELECT id FROM service_events WHERE service_id = ? AND kind = 'release'", UI_ID)).toHaveLength(1);
  });

  it("形の違うコミットと、package.json を変えていない push では読まない", async () => {
    const link = await linked(world);
    await hook(world, {
      event: "push",
      secret: link.webhookSecret,
      payload: { ref: "refs/heads/main", before: sha(0), after: "../../x", repository: { full_name: UI_REPO, default_branch: "main" }, installation: { id: link.installationId } },
    });
    await pushTo(world, link, UI_REPO, 3, "refs/heads/main", { commits: [{ id: sha(3), added: [], removed: [], modified: ["README.md"] }] });
    expect(contentReads(world)).toBe(0);
    await pushTo(world, link, UI_REPO, 4, "refs/heads/main", { commits: [{ id: sha(4), added: [], removed: [], modified: ["packages/ui/package.json"] }] });
    expect(contentReads(world)).toBeGreaterThan(0);
  });

  it("main 以外への push と、読めないファイルでは何も残さない", async () => {
    const link = await linked(world);
    for (const path of Object.keys(UI_MANIFESTS)) world.gate.github.contents.set(`${sha(1)}:${path}`, JSON.stringify({ version: "0.13.0" }));
    expect((await pushTo(world, link, UI_REPO, 1, "refs/heads/topic")).status).toBe(204);
    world.gate.github.contents.set(`${sha(2)}:packages/ui/package.json`, "{ not json");
    expect((await pushTo(world, link, UI_REPO, 2)).status).toBe(204);
    expect(await rows(world.d1.DB, "SELECT kind FROM service_events WHERE service_id = ? AND kind <> 'stage'", UI_ID)).toEqual([]);
  });
});

describe("前のバージョンに戻す", () => {
  const dispatch = `POST /repos/${OFFICE_REPO}/actions/workflows/rollback.yml/dispatches`;

  it("手で戻す", async () => {
    await linked(world);
    // つなぐ時に確かめたパスキーは切れた事にする
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = 0").run();
    expect(await api(world, "POST", `/api/v1/services/${OFFICE_ID}/rollback`, { reason: "失敗が増えた" }, 401)).toMatchObject({ code: "step_up_required" });
    await stepUp(world);
    const deployment = z.object({ id: z.string(), status: z.literal("queued") }).strict().parse(await api(world, "POST", `/api/v1/services/${OFFICE_ID}/rollback`, { reason: "失敗が増えた" }, 202));
    expect(world.gate.github.requests.filter((r) => r.route === dispatch)).toEqual([expect.objectContaining({ body: { ref: "main", inputs: { reason: "失敗が増えた" } } })]);
    expect(await rows(world.d1.DB, "SELECT id, kind, by FROM service_events WHERE service_id = ? AND kind = 'rollback'", OFFICE_ID)).toEqual([{ id: deployment.id, kind: "rollback", by: "owner" }]);
    expect(world.gate.audits).toContainEqual(expect.objectContaining({ action: "service.rollback", target: OFFICE_ID }));
    expect(await rows(world.d1.DB, "SELECT kind, level, scope FROM notices WHERE kind = 'service_rollback'")).toEqual([{ kind: "service_rollback", level: "info", scope: OFFICE_ID }]);
    expect(await statusOf(world, OFFICE_ID)).toMatchObject({ kind: "web_app", rolledBackAt: expect.any(String) as unknown });
  });

  it("Web アプリでないサービスは戻さない", async () => {
    await linked(world);
    await stepUp(world);
    expect(await api(world, "POST", `/api/v1/services/${UI_ID}/rollback`, { reason: "戻す" }, 409)).toMatchObject({ code: "conflict" });
    expect(await api(world, "POST", "/api/v1/services/0192f5c0-0000-7000-8000-000000000000/rollback", { reason: "戻す" }, 404)).toMatchObject({ code: "not_found" });
  });

  it("GitHub が失敗したら 502 で、戻した記録を残さない", async () => {
    await linked(world);
    await stepUp(world);
    world.gate.github.failNext(dispatch, 500);
    expect(await api(world, "POST", `/api/v1/services/${OFFICE_ID}/rollback`, { reason: "戻す" }, 502)).toMatchObject({ code: "upstream_failed" });
    expect(await rows(world.d1.DB, "SELECT id FROM service_events WHERE kind = 'rollback'")).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT id FROM notices WHERE kind = 'service_rollback'")).toEqual([]);
  });
});
