// サービスごとの設定が office の初期値を受け継ぐ事。変えていない項目は初期値に従い、変えた項目だけがそのサービスに効く (サービスと拡張の 3.3)
import { newId } from "@know-office/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { services } from "../../src/gate/db/main.ts";
import { appendServiceSetting, serviceRules } from "../../src/gate/services/settings.ts";
import { planDay } from "../../src/gate/work/plan.ts";
import { api, at, MINUTE, type WorkWorld, useWork } from "../helpers/work.ts";

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
    const [row] = await drizzle(world.d1.DB).select({ staffId: services.staffId }).from(services).where(eq(services.id, ui));
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
    expect(await count(world, `SELECT COUNT(*) AS n FROM service_settings WHERE service_id = '${ui}'`)).toBe(1);
  });

  it("古い版で弱める変更は、パスキーの確認より先に版の違いで断る", async () => {
    const ui = await service(world, "knowidea-ui", "example/knowidea-ui");
    // 先に強めた後で、読んだ時の版 0 のまま元の値へ戻すのは、今の値から見ると弱める変更になる
    await api(world, "PUT", `/api/v1/services/${ui}/settings/mergeWhen`, { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" });
    expect(await api(world, "PUT", `/api/v1/services/${ui}/settings/mergeWhen`, { version: 0, value: ["checks", "reviewer"], reason: "古い版" }, 409)).toMatchObject({ code: "conflict" });
    await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer", "owner"], reason: "強める" });
    expect(await api(world, "PUT", "/api/v1/settings/service.mergeWhen", { version: 0, value: ["checks", "reviewer"], reason: "古い版" }, 409)).toMatchObject({ code: "conflict" });
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
    expect(await count(world, `SELECT COUNT(*) AS n FROM service_settings WHERE service_id = '${ui}'`)).toBe(1);
    await expect(write(1)).resolves.toBeUndefined();
    expect(await count(world, `SELECT COUNT(*) AS n FROM service_settings WHERE service_id = '${ui}'`)).toBe(2);
  });
});

describe("勤務の時間", () => {
  const SCHEDULE = "/api/v1/settings/workday.schedule";
  const ALL = [0, 1, 2, 3, 4, 5, 6];

  it("時刻を変える", async () => {
    // 始まりを遅らせるだけなら勤務は延びないので、パスキー無しで通る
    const changed = await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "10:00", end: "17:00", days: ALL }, reason: "朝を遅くする" });
    expect(changed).toEqual({ key: "workday.schedule", value: { start: "10:00", end: "17:00", days: ALL }, inherited: false, version: 1 });
    expect((await officeSettings(world))["workday.schedule"]).toEqual(changed);
    expect(await planDay(world.d1.DB, "builder", "2026-12-01")).toMatchObject({ start: at(10), scheduledEnd: at(17) });
    expect(world.gate.audits.filter((a) => a.action === "setting.update")).toEqual([
      expect.objectContaining({ target: "workday.schedule", detail: { value: { start: "10:00", end: "17:00", days: ALL }, version: 1, reason: "朝を遅くする" } }),
    ]);
    // 古い版から変える事は断る
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "11:00", end: "17:00", days: ALL }, reason: "古い版から" }, 409);
  });

  it("予定を組み直せなかった社員がいても変更は残り、その社員をエラーログに残す", async () => {
    world.gate.staff.builder.book.wake = () => Promise.reject(new Error("StaffDO に届かない"));
    const changed = await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "10:00", end: "17:00", days: ALL }, reason: "朝を遅くする" });
    expect(changed).toMatchObject({ version: 1 });
    expect((await officeSettings(world))["workday.schedule"]).toEqual(changed);
    const { results } = await world.d1.REC_2026.prepare("SELECT source, level, code, message, route FROM error_events").all();
    expect(results).toEqual([
      { source: "gate", level: "warn", code: "schedule_rearm_failed", message: "Error: builder の予定を組み直せなかった: StaffDO に届かない", route: "/api/v1/settings/:key" },
    ]);
  });

  it("同じ版から同時に変える", async () => {
    const put = (start: string) =>
      world.gate.request(SCHEDULE, {
        method: "PUT",
        headers: { ...world.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ version: 0, value: { start, end: "17:00", days: ALL }, reason: "同時に変える" }),
      });
    const statuses = (await Promise.all([put("10:00"), put("11:00")])).map((r) => r.status);
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 409]);
    const rows = await world.d1.DB.prepare("SELECT version FROM settings WHERE key = 'workday.schedule'").all<{ version: number }>();
    expect(rows.results.map((r) => r.version)).toEqual([1]);
    expect(world.gate.audits.filter((a) => a.action === "setting.update")).toHaveLength(1);
  });

  it("延ばす変更はパスキーで確かめる", async () => {
    const code = z.object({ code: z.string() }).loose();
    // 終わりを遅らせる、曜日を足す、日をまたいで延ばす、はどれも働く時間が増える
    expect(code.parse(await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "18:00", days: ALL }, reason: "延ばす" }, 401)).code).toBe("step_up_required");
    expect(code.parse(await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "17:00", end: "09:00", days: ALL }, reason: "夜に働く" }, 401)).code).toBe("step_up_required");
    expect(await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }, reason: "週末を休む" })).toMatchObject({ version: 1 });
    expect(code.parse(await api(world, "PUT", SCHEDULE, { version: 1, value: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5, 6] }, reason: "土曜を足す" }, 401)).code).toBe("step_up_required");
    // 断った変更は書かない
    expect((await officeSettings(world))["workday.schedule"]).toMatchObject({ version: 1 });
    await stepUp(world);
    expect(await api(world, "PUT", SCHEDULE, { version: 1, value: { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] }, reason: "延ばす" })).toMatchObject({ version: 2 });
  });

  it("形の違う値を断る", async () => {
    await stepUp(world);
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "09:00", days: ALL }, reason: "同じ時刻" }, 422);
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "9:00", end: "17:00", days: ALL }, reason: "形が違う" }, 422);
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "24:00", days: ALL }, reason: "無い時刻" }, 422);
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "17:00", days: [] }, reason: "曜日が空" }, 422);
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "17:00", days: [1, 1] }, reason: "同じ曜日" }, 422);
    await api(world, "PUT", SCHEDULE, { version: 0, value: { start: "09:00", end: "17:00", days: [7] }, reason: "無い曜日" }, 422);
    await api(world, "PUT", SCHEDULE, { version: 0, value: null, reason: "消す" }, 422);
    expect((await officeSettings(world))["workday.schedule"]).toMatchObject({ inherited: true, version: 0 });
  });
});
