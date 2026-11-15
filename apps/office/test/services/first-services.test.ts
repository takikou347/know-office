// 最初の 2 つのサービス。knowidea-ui を 1 番目、know-office 自身を 2 番目に、空の D1 へのマイグレーションで登録する (サービスと拡張の 3.1 と 3.3)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, useWork } from "../helpers/work.ts";

const world = useWork();

const SEED = join(import.meta.dirname, "../../migrations/main/0006_seed_services.sql");

const Card = z.object({ id: z.string(), name: z.string(), kind: z.string(), stage: z.string(), staffId: z.string().nullable(), repo: z.string().nullable() }).strict();
const SettingRow = z.object({ key: z.string(), value: z.unknown(), inherited: z.boolean(), version: z.number() }).strict();

/**
 * 登録したサービスの一覧を、登録の順で読む
 * @returns サービスの一覧
 */
async function listed(): Promise<z.infer<typeof Card>[]> {
  return z.array(Card).parse(await api(world, "GET", "/api/v1/services"));
}

/**
 * サービスの設定を読み、キーから 1 件への対応にする
 * @param serviceId サービス ID
 * @returns キーごとの設定
 */
async function settingsOf(serviceId: string): Promise<Record<string, z.infer<typeof SettingRow>>> {
  const rows = z.array(SettingRow).parse(await api(world, "GET", `/api/v1/services/${serviceId}/settings`));
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

/**
 * 名前でサービスを選ぶ
 * @param name サービスの名前
 * @returns サービス
 */
async function byName(name: string): Promise<z.infer<typeof Card>> {
  const found = (await listed()).find((s) => s.name === name);
  if (!found) throw new Error(`${name} が登録されていない`);
  return found;
}

describe("最初のサービスは knowidea-ui", () => {
  it("空の D1 にマイグレーションを流すと、knowidea-ui が 1 番目のサービスとして運用の段階に入る", async () => {
    const [first] = await listed();
    expect(first).toMatchObject({ name: "knowidea-ui", kind: "library", stage: "operation", repo: "takikou347/knowidea-ui", staffId: "builder" });
  });

  it("knowidea-ui は登録した時から、本番にデプロイする条件にチェックとレビュー担当の承認を持つ", async () => {
    const ui = await byName("knowidea-ui");
    const got = await settingsOf(ui.id);
    expect(got["deployWhen"]).toEqual({ key: "deployWhen", value: ["checks", "reviewer"], inherited: false, version: 1 });
    // ほかの項目は office の初期値を受け継ぐ
    expect(got["mergeWhen"]).toMatchObject({ value: ["checks", "reviewer"], inherited: true, version: 0 });
    expect(got["repo"]).toMatchObject({ value: "takikou347/knowidea-ui", inherited: false });
    expect(got["staffId"]).toMatchObject({ value: "builder", inherited: false });
  });
});

describe("know-office 自身を管理する", () => {
  it("空の D1 にマイグレーションを流すと、know-office 自身が 2 番目のサービスとして試作の段階に入る", async () => {
    const [, second, ...rest] = await listed();
    expect(second).toMatchObject({ name: "know-office", kind: "web_app", stage: "prototype", repo: "takikou347/know-office", staffId: "builder" });
    expect(rest).toEqual([]);
  });

  it("know-office の本番にデプロイする条件は、office の初期値のオーナーの承認を受け継ぐ", async () => {
    const office = await byName("know-office");
    const got = await settingsOf(office.id);
    expect(got["deployWhen"]).toEqual({ key: "deployWhen", value: ["owner"], inherited: true, version: 0 });
  });
});

describe("最初の 2 つのサービスの登録", () => {
  it("登録の SQL を何度流しても、サービスも設定も 2 重にならない", async () => {
    const before = await listed();
    const statements = readFileSync(SEED, "utf8")
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    for (const sql of statements) await world.d1.DB.prepare(sql).run();
    await world.d1.DB.batch(statements.map((sql) => world.d1.DB.prepare(sql)));
    expect(await listed()).toEqual(before);
    const settings = await world.d1.DB.prepare("SELECT COUNT(*) AS n FROM service_settings").first<{ n: number }>();
    expect(settings?.n).toBe(1);
    const events = await world.d1.DB.prepare("SELECT COUNT(*) AS n FROM service_events").first<{ n: number }>();
    expect(events?.n).toBe(2);
  });
});
