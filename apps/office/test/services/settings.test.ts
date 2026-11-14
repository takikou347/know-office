// サービスごとの設定が office の初期値を受け継ぐ事。変えていない項目は初期値に従い、変えた項目だけがそのサービスに効く (サービスと拡張の 3.3)
import { newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { services } from "../../src/gate/db/main.ts";
import { appendServiceSetting, serviceRules } from "../../src/gate/services/settings.ts";
import { api, MINUTE, type WorkWorld, useWork } from "../helpers/work.ts";

const world = useWork();

const SettingRow = z.object({ key: z.string(), value: z.unknown(), inherited: z.boolean(), version: z.number() }).strict();

/**
 * サービスを 1 つ置く。登録の流れ (9.2) の代わりに、リポジトリと担当の社員を決めた行を直に入れる
 * @param w テストの物
 * @param name サービスの名前
 * @param repo リポジトリ
 * @returns サービス ID
 */
async function service(w: WorkWorld, name: string, repo: string): Promise<string> {
  const id = newId(w.clock);
  await drizzle(w.d1.DB).insert(services).values({ id, name, kind: "library", stage: "operation", repo, staffId: "builder", createdAt: w.clock.now() });
  return id;
}

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * サービスの設定を読み、キーから 1 件への対応にする
 * @param w テストの物
 * @param serviceId サービス ID
 * @returns キーごとの設定
 */
async function settingsOf(w: WorkWorld, serviceId: string): Promise<Record<string, z.infer<typeof SettingRow>>> {
  const rows = z.array(SettingRow).parse(await api(w, "GET", `/api/v1/services/${serviceId}/settings`));
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

/**
 * office の設定を読み、キーから 1 件への対応にする
 * @param w テストの物
 * @returns キーごとの設定
 */
async function officeSettings(w: WorkWorld): Promise<Record<string, z.infer<typeof SettingRow>>> {
  const rows = z.array(SettingRow).parse(await api(w, "GET", "/api/v1/settings"));
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

describe("サービスごとの設定", () => {
  it("初期値に従う", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const got = await settingsOf(world, ui);
    expect(Object.keys(got)).toEqual(["repo", "staffId", "actions", "mergeWhen", "deployWhen", "protectedPaths", "paused"]);
    // main に入れる条件を変えていないので、office の初期値 (チェックとレビュー担当の承認) が使われる
    expect(got["mergeWhen"]).toEqual({ key: "mergeWhen", value: ["checks", "reviewer"], inherited: true, version: 0 });
    expect(got["deployWhen"]).toMatchObject({ value: ["owner"], inherited: true });
    expect(got["actions"]).toMatchObject({ value: ["read", "branch", "push", "pull_request", "merge", "issue"], inherited: true });
    expect(got["protectedPaths"]).toMatchObject({ value: [".github/workflows/"], inherited: true });
    expect(got["paused"]).toMatchObject({ value: false, inherited: true });
    // リポジトリと担当の社員は登録の時に決め、初期値を持たない
    expect(got["repo"]).toMatchObject({ value: "example/knowidea-ui", inherited: false });
    expect(got["staffId"]).toMatchObject({ value: "builder", inherited: false });
    // ゲートウェイがルールを判断する時も、受け継いだ値を使う
    expect(await serviceRules(world.d1.DB, ui)).toMatchObject({ mergeWhen: ["checks", "reviewer"], deployWhen: ["owner"], paused: false });
  });

  it("サービスだけ変える", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const office = await service(world, "know-office", "example/know-office");
    // オーナーの承認を外すのは守りを弱める変更なので、パスキーで確かめてから変える
    await stepUp(world);
    const changed = await api(world, "PUT", `/api/v1/services/${ui}/settings/deployWhen`, { version: 0, value: ["checks", "reviewer"], reason: "ライブラリはチェックとレビューで出す" });
    expect(changed).toEqual({ key: "deployWhen", value: ["checks", "reviewer"], inherited: false, version: 1 });
    // そのサービスだけに効き、「初期値から変えている」と出る
    expect((await settingsOf(world, ui))["deployWhen"]).toEqual({ key: "deployWhen", value: ["checks", "reviewer"], inherited: false, version: 1 });
    expect(await serviceRules(world.d1.DB, ui)).toMatchObject({ deployWhen: ["checks", "reviewer"] });
    // ほかのサービスと office の初期値は変わらない
    expect((await settingsOf(world, office))["deployWhen"]).toMatchObject({ value: ["owner"], inherited: true });
    expect((await officeSettings(world))["service.deployWhen"]).toMatchObject({ value: ["owner"], version: 0 });
    expect(world.gate.audits.filter((a) => a.action === "service.setting")).toEqual([
      expect.objectContaining({ target: ui, detail: { key: "deployWhen", value: ["checks", "reviewer"], version: 1, reason: "ライブラリはチェックとレビューで出す" } }),
    ]);
    // 古い版を見て直した物は断る
    await api(world, "PUT", `/api/v1/services/${ui}/settings/deployWhen`, { version: 0, value: ["owner"], reason: "古い版から" }, 409);
    // null を送ると初期値に戻る
    expect(await api(world, "PUT", `/api/v1/services/${ui}/settings/deployWhen`, { version: 1, value: null, reason: "初期値に戻す" })).toEqual({
      key: "deployWhen",
      value: ["owner"],
      inherited: true,
      version: 2,
    });
  });

  it("office の初期値を変える", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const office = await service(world, "know-office", "example/know-office");
    await stepUp(world);
    await api(world, "PUT", `/api/v1/services/${ui}/settings/mergeWhen`, { version: 0, value: ["reviewer"], reason: "文書だけのリポジトリ" });
    const changed = await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "owner"], reason: "main はオーナーが入れる" });
    expect(changed).toEqual({ key: "service.mergeWhen", value: ["checks", "owner"], inherited: false, version: 1 });
    // その項目を変えていないサービスにだけ新しい値が効く
    expect((await settingsOf(world, office))["mergeWhen"]).toMatchObject({ value: ["checks", "owner"], inherited: true });
    expect((await settingsOf(world, ui))["mergeWhen"]).toMatchObject({ value: ["reviewer"], inherited: false });
    expect(await serviceRules(world.d1.DB, office)).toMatchObject({ mergeWhen: ["checks", "owner"] });
    expect(await serviceRules(world.d1.DB, ui)).toMatchObject({ mergeWhen: ["reviewer"] });
    expect(world.gate.audits.filter((a) => a.action === "setting.update")).toEqual([
      expect.objectContaining({ target: "service.mergeWhen", detail: { value: ["checks", "owner"], version: 1, reason: "main はオーナーが入れる" } }),
    ]);
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks"], reason: "古い版から" }, 409);
  });
});

describe("設定の入力", () => {
  it("知らないサービス、知らない項目、専用のルートで変える項目は 404 にする", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    await api(world, "GET", `/api/v1/services/${newId(world.clock)}/settings`, undefined, 404);
    await api(world, "PUT", `/api/v1/services/${newId(world.clock)}/settings/paused`, { version: 0, value: true, reason: "止める" }, 404);
    await api(world, "PUT", `/api/v1/services/${ui}/settings/budget`, { version: 0, value: 1, reason: "無い項目" }, 404);
    // リポジトリは触れるリポジトリから選ぶので、GitHub とつなぐまで変えられない
    await api(world, "PUT", `/api/v1/services/${ui}/settings/repo`, { version: 0, value: "example/other", reason: "移す" }, 404);
    await api(world, "PUT", "/api/v1/settings/guard.thresholds", { version: 0, value: {}, reason: "専用のルートで変える" }, 404);
    await api(world, "PUT", "/api/v1/settings/github.rules", { version: 0, value: {}, reason: "専用のルートで変える" }, 404);
    await api(world, "PUT", "/api/v1/settings/service.repo", { version: 0, value: "example/x", reason: "初期値を持たない" }, 404);
    expect(world.gate.audits.filter((a) => a.action === "service.setting" || a.action === "setting.update")).toEqual([]);
  });

  it("項目の形に合わない値と、初期値を持たない項目を初期値に戻す事は 422 にする", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const wrong = z.object({ errors: z.array(z.object({ pointer: z.string() })) }).loose();
    const bad = wrong.parse(await api(world, "PUT", `/api/v1/services/${ui}/settings/mergeWhen`, { version: 0, value: ["anyone"], reason: "形が違う" }, 422));
    expect(bad.errors[0]?.pointer).toBe("#/value/0");
    await api(world, "PUT", `/api/v1/services/${ui}/settings/mergeWhen`, { version: 0, value: [], reason: "条件が空" }, 422);
    await api(world, "PUT", `/api/v1/services/${ui}/settings/staffId`, { version: 0, value: null, reason: "担当を外す" }, 422);
    await api(world, "PUT", "/api/v1/settings/service.paused", { version: 0, value: null, reason: "初期値を消す" }, 422);
    expect((await settingsOf(world, ui))["mergeWhen"]).toMatchObject({ inherited: true, version: 0 });
  });

  it("担当の社員を変えると、サービスの担当も変わる", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    expect(await api(world, "PUT", `/api/v1/services/${ui}/settings/staffId`, { version: 0, value: "president", reason: "社長に任せる" })).toEqual({
      key: "staffId",
      value: "president",
      inherited: false,
      version: 1,
    });
    const [row] = await drizzle(world.d1.DB).select({ staffId: services.staffId }).from(services);
    expect(row?.staffId).toBe("president");
  });
});

/** 弱める変更 1 件。before があれば先にパスキー無しで入れ、after で弱める */
type Weakening = { name: string; key: string; before?: unknown; after: unknown };

const SERVICE_WEAKENINGS: Weakening[] = [
  { name: "できる操作に今の値に無い操作を足す", key: "actions", before: ["read"], after: ["read", "push"] },
  { name: "main にマージする条件から条件を外す", key: "mergeWhen", after: ["reviewer"] },
  { name: "本番にデプロイする条件から条件を外す", key: "deployWhen", after: ["checks", "reviewer"] },
  { name: "触れない所から道を外す", key: "protectedPaths", after: [] },
  { name: "止めたサービスを動かす", key: "paused", before: true, after: false },
  { name: "初期値に戻した結果が弱める時", key: "paused", before: true, after: null },
];

describe("弱める変更だけパスキーを求める", () => {
  it.each(SERVICE_WEAKENINGS)("$name", async (c) => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const path = `/api/v1/services/${ui}/settings/${c.key}`;
    let version = 0;
    if (c.before !== undefined) {
      // 強める変更はパスキー無しで通る
      await api(world, "PUT", path, { version, value: c.before, reason: "強める" });
      version += 1;
    }
    const refused = z.object({ code: z.string() }).loose().parse(await api(world, "PUT", path, { version, value: c.after, reason: "弱める" }, 401));
    expect(refused.code).toBe("step_up_required");
    await stepUp(world);
    expect(await api(world, "PUT", path, { version, value: c.after, reason: "弱める" })).toMatchObject({ key: c.key, version: version + 1 });
  });

  it("強める変更と同じ値はパスキー無しで通す", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const put = (key: string, version: number, value: unknown) => api(world, "PUT", `/api/v1/services/${ui}/settings/${key}`, { version, value, reason: "強める" });
    expect(await put("mergeWhen", 0, ["checks", "reviewer", "owner"])).toMatchObject({ version: 1 });
    expect(await put("mergeWhen", 1, ["checks", "reviewer", "owner"])).toMatchObject({ version: 2 });
    expect(await put("actions", 0, ["read", "branch"])).toMatchObject({ version: 1 });
    expect(await put("protectedPaths", 0, [".github/workflows/", "migrations/"])).toMatchObject({ version: 1 });
    expect(await put("paused", 0, true)).toMatchObject({ version: 1 });
    // 受け継いだ値と同じ所へ戻すのは弱めない
    expect(await put("deployWhen", 0, null)).toMatchObject({ inherited: true, version: 1 });
  });

  it("office の初期値を弱める", async () => {
    const refused = z.object({ code: z.string() }).loose().parse(await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 0, value: [], reason: "弱める" }, 401));
    expect(refused.code).toBe("step_up_required");
    expect(await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" })).toMatchObject({ version: 1 });
    await stepUp(world);
    expect(await api(world, "PUT", "/api/v1/settings/service.protectedPaths", { version: 0, value: [], reason: "弱める" })).toMatchObject({ version: 1 });
  });
});

/**
 * 表の行を数える
 * @param w テストの物
 * @param sql 数える SQL
 * @returns 行の数
 */
async function count(w: WorkWorld, sql: string): Promise<number> {
  return z.object({ n: z.number() }).parse(await w.d1.DB.prepare(sql).first()).n;
}

describe("同時に変えた時の版", () => {
  it("同じ版でサービスの設定を同時に変えると、片方だけが入る", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    const send = (value: string[]) => world.gate.request(`/api/v1/services/${ui}/settings/mergeWhen`, {
      method: "PUT",
      headers: { ...world.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, value, reason: "同時に変える" }),
    });
    const res = await Promise.all([send(["checks", "reviewer", "owner"]), send(["checks", "reviewer"])]);
    expect(res.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await count(world, "SELECT COUNT(*) AS n FROM service_settings")).toBe(1);
  });

  it("同じ版で office の初期値を同時に変えると、片方だけが入る", async () => {
    const send = (value: string[]) => world.gate.request("/api/v1/settings/service.mergeWhen", {
      method: "PUT",
      headers: { ...world.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 0, value, reason: "同時に変える" }),
    });
    const res = await Promise.all([send(["checks", "reviewer", "owner"]), send(["checks", "reviewer"])]);
    expect(res.map((r) => r.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await count(world, "SELECT COUNT(*) AS n FROM settings WHERE key = 'service.mergeWhen'")).toBe(1);
  });

  it("初期値に戻す間に office の初期値が変わると、戻さずに断る", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    await api(world, "PUT", `/api/v1/services/${ui}/settings/paused`, { version: 0, value: true, reason: "止める" });
    // 戻す前に office の初期値 (版 0 の false) を読んだ後、初期値が変わった事にする
    await api(world, "PUT", "/api/v1/settings/service.paused", { version: 0, value: true, reason: "全部止める" });
    const write = (defaultVersion: number) =>
      appendServiceSetting(world.d1.DB, { serviceId: ui, key: "paused", value: null, version: 1, defaultVersion, now: world.clock.now() });
    await expect(write(0)).rejects.toMatchObject({ code: "conflict" });
    expect(await count(world, "SELECT COUNT(*) AS n FROM service_settings")).toBe(1);
    await expect(write(1)).resolves.toBeUndefined();
    expect(await count(world, "SELECT COUNT(*) AS n FROM service_settings")).toBe(2);
  });
});
