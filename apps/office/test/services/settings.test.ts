// サービスごとの設定が office の初期値を受け継ぐ事。変えていない項目は初期値に従い、変えた項目だけがそのサービスに効く (サービスと拡張の 3.3)
import { newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { services } from "../../src/gate/db/main.ts";
import { serviceRules } from "../../src/gate/services/settings.ts";
import { api, type WorkWorld, useWork } from "../helpers/work.ts";

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
    await api(world, "PUT", "/api/v1/settings/guard.thresholds", { version: 0, value: {}, reason: "専用のルートで変える" }, 404);
    await api(world, "PUT", "/api/v1/settings/github.rules", { version: 0, value: {}, reason: "専用のルートで変える" }, 404);
    await api(world, "PUT", "/api/v1/settings/service.repo", { version: 0, value: "example/x", reason: "初期値を持たない" }, 404);
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
