// サービスの設定を office の初期値と合わせて組み立て、変える。ルールの判断もここで組み立てた値を使う (サービスと拡張の 3.3)
import type { D1Database } from "@cloudflare/workers-types";
import {
  AppError,
  DEFAULT_SERVICE_RULES,
  INHERITED_KEYS,
  INHERITED_SETTINGS,
  type InheritedKey,
  newId,
  OWN_SETTINGS,
  type ServiceRules,
  type Setting,
} from "@know-office/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z, type ZodType } from "zod";
import { toFieldErrors } from "../app.ts";
import { services, serviceSettings, settings } from "../db/main.ts";
import { clockAt } from "../work/attendance.ts";

/** office の初期値を置く `settings` のキーの頭。`service.mergeWhen` のように項目の名前を続ける */
export const DEFAULT_PREFIX = "service.";

/** サービスの設定の項目の並び。初期値を持たない 2 つを先に出す */
export const SERVICE_KEYS = ["repo", "staffId", ...INHERITED_KEYS] as const;

type OfficeDefault = { value: unknown; version: number; set: boolean };

// 受け継いだ値をまとめて確かめる形。repo と staffId は判断に使わないので落とす
const RULES = z.object(INHERITED_SETTINGS);

/**
 * 項目の名前が、office の初期値を受け継ぐ項目かを見る
 * @param key 項目の名前
 * @returns 受け継ぐ項目なら true
 */
export function isInheritedKey(key: string): key is InheritedKey {
  return (INHERITED_KEYS as readonly string[]).includes(key);
}

/**
 * 置いた値を項目の形で確かめる。形の違う値で判断すると守りが外れるので、読めない時は失敗にする
 * @param schema 項目の形
 * @param value 置いた値
 * @param where 置き場の名前
 * @returns 確かめた値
 * @throws internal 置いた値の形が違う時
 */
function stored(schema: ZodType, value: unknown, where: string): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("internal", `${where} の形が違う`);
  return parsed.data;
}

/**
 * 入力の値を項目の形で確かめる
 * @param schema 項目の形
 * @param value 送られた値
 * @returns 確かめた値
 * @throws validation_failed 値が項目の形に合わない時
 */
export function checkValue(schema: ZodType, value: unknown): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("validation_failed", "値が項目の形に合わない", { errors: toFieldErrors(parsed.error, "json").map((e) => ({ ...e, pointer: e.pointer.replace(/^#/, "#/value") })) });
  }
  return parsed.data;
}

/**
 * office の初期値を、項目ごとに最新の行から読む。行が無い項目は組み込みの値をバージョン 0 で使う
 * @param db 今の状態の D1
 * @returns 項目ごとの値、バージョン、置いた行があるか
 * @throws internal 置いた値の形が違う時
 */
export async function loadOfficeDefaults(db: D1Database): Promise<Record<InheritedKey, OfficeDefault>> {
  const rows = await drizzle(db)
    .select({ key: settings.key, value: settings.value, version: settings.version })
    .from(settings)
    .where(and(eq(settings.scope, "office"), inArray(settings.key, INHERITED_KEYS.map((k) => `${DEFAULT_PREFIX}${k}`))))
    .orderBy(desc(settings.version));
  const one = (key: InheritedKey): OfficeDefault => {
    const row = rows.find((r) => r.key === `${DEFAULT_PREFIX}${key}`);
    if (!row) return { value: DEFAULT_SERVICE_RULES[key], version: 0, set: false };
    return { value: stored(INHERITED_SETTINGS[key], row.value, `settings の ${DEFAULT_PREFIX}${key}`), version: row.version, set: true };
  };
  return { actions: one("actions"), mergeWhen: one("mergeWhen"), deployWhen: one("deployWhen"), protectedPaths: one("protectedPaths"), paused: one("paused") };
}

/**
 * サービスの行を読む
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns リポジトリと担当の社員
 * @throws not_found サービスが無い時
 */
async function findService(db: D1Database, serviceId: string): Promise<{ repo: string | null; staffId: string | null }> {
  const [row] = await drizzle(db).select({ repo: services.repo, staffId: services.staffId }).from(services).where(eq(services.id, serviceId)).limit(1);
  if (!row) throw new AppError("not_found", "サービスが無い");
  return row;
}

/**
 * サービスの設定を、項目ごとの最新の行と office の初期値から組み立てる
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns SERVICE_KEYS の順の設定
 * @throws not_found サービスが無い時
 * @throws internal 置いた値の形が違う時
 */
export async function loadServiceSettings(db: D1Database, serviceId: string): Promise<Setting[]> {
  const service = await findService(db, serviceId);
  const [rows, defaults] = await Promise.all([
    drizzle(db).select({ key: serviceSettings.key, value: serviceSettings.value, version: serviceSettings.version }).from(serviceSettings).where(eq(serviceSettings.serviceId, serviceId)).orderBy(desc(serviceSettings.version)),
    loadOfficeDefaults(db),
  ]);
  const latest = (key: string) => rows.find((r) => r.key === key);
  const own = (key: "repo" | "staffId"): Setting => {
    // 登録の時に決めた値は services の行にあり、後から変えた値は service_settings の最新の行にある
    const row = latest(key);
    const value = row ? stored(OWN_SETTINGS[key], row.value, `service_settings の ${key}`) : service[key];
    return { key, value, inherited: false, version: row?.version ?? 0 };
  };
  const inherited = (key: InheritedKey): Setting => {
    const row = latest(key);
    // null の行は初期値に戻した印
    if (!row || row.value === null) return { key, value: defaults[key].value, inherited: true, version: row?.version ?? 0 };
    return { key, value: stored(INHERITED_SETTINGS[key], row.value, `service_settings の ${key}`), inherited: false, version: row.version };
  };
  return [own("repo"), own("staffId"), ...INHERITED_KEYS.map(inherited)];
}

/**
 * ルールの判断に使う、受け継いだ値をまとめたサービスの設定を組み立てる。値を持ち置きせず、判断のたびに読む
 * @param db 今の状態の D1
 * @param serviceId サービス ID
 * @returns 受け継いだ値
 * @throws not_found サービスが無い時
 * @throws internal 置いた値の形が違う時
 */
export async function serviceRules(db: D1Database, serviceId: string): Promise<ServiceRules> {
  const all = await loadServiceSettings(db, serviceId);
  return RULES.parse(Object.fromEntries(all.map((s) => [s.key, s.value])));
}

/**
 * サービスの設定を 1 項目変える。読んだ版のままの時だけ書き、同時に変えた 2 つの片方を断る
 * @param db 今の状態の D1
 * @param input サービス ID、項目、値、読んだ版、今の時刻
 * @param input.serviceId サービス ID
 * @param input.key 項目の名前
 * @param input.value 値。null は初期値に戻す
 * @param input.version 読んだ版
 * @param input.now 今の時刻
 * @returns 変えた後の設定
 * @throws not_found サービスか項目が無い時、リポジトリを変えようとした時
 * @throws validation_failed 値が項目の形に合わない時、初期値を持たない項目を null にした時
 * @throws conflict 版が違う時
 */
export async function updateServiceSetting(
  db: D1Database,
  input: { serviceId: string; key: string; value: unknown; version: number; now: number },
): Promise<Setting> {
  const { serviceId, key, version, now } = input;
  await findService(db, serviceId);
  // リポジトリは触れるリポジトリの中から選ぶので、触れるリポジトリを読めるまで変えさせない
  if (key !== "staffId" && !isInheritedKey(key)) throw new AppError("not_found", "変えられる設定の項目でない");
  let value: unknown = null;
  if (key === "staffId") value = checkValue(OWN_SETTINGS.staffId, input.value);
  else if (input.value !== null) value = checkValue(INHERITED_SETTINGS[key], input.value);
  const current = (await loadServiceSettings(db, serviceId)).find((s) => s.key === key);
  if (current?.version !== version) throw new AppError("conflict", "バージョンが違う");
  const id = newId(clockAt(now));
  const next = version + 1;
  const orm = drizzle(db);
  const json = value === null ? null : JSON.stringify(value);
  const insert = orm
    .insert(serviceSettings)
    .select(
      sql`SELECT ${id}, ${serviceId}, ${key}, ${json}, ${next}, 'owner', ${now} WHERE NOT EXISTS (SELECT 1 FROM ${serviceSettings} WHERE ${serviceSettings.serviceId} = ${serviceId} AND ${serviceSettings.key} = ${key} AND ${serviceSettings.version} >= ${next})`,
    )
    .returning({ id: serviceSettings.id });
  if (key === "staffId") {
    // 一覧の担当も同じ時に直す。行を書けた時だけ直す
    const [written] = await orm.batch([
      insert,
      orm
        .update(services)
        .set({ staffId: OWN_SETTINGS.staffId.parse(value) })
        .where(and(eq(services.id, serviceId), sql`EXISTS (SELECT 1 FROM ${serviceSettings} WHERE ${serviceSettings.id} = ${id})`)),
    ]);
    if (written.length === 0) throw new AppError("conflict", "バージョンが違う");
  } else if ((await insert).length === 0) {
    throw new AppError("conflict", "バージョンが違う");
  }
  const after = (await loadServiceSettings(db, serviceId)).find((s) => s.key === key);
  if (!after) throw new AppError("internal", "書いた設定が読めない");
  return after;
}

/**
 * office の初期値を 1 項目変える。読んだ版のままの時だけ書く
 * @param db 今の状態の D1
 * @param input 項目、値、読んだ版、理由、今の時刻
 * @param input.key `service.<項目>` の形のキー
 * @param input.value 値
 * @param input.version 読んだ版
 * @param input.reason 理由
 * @param input.now 今の時刻
 * @returns 変えた後の設定
 * @throws not_found このルートで変えられる項目でない時
 * @throws validation_failed 値が項目の形に合わない時
 * @throws conflict 版が違う時
 */
export async function updateOfficeDefault(db: D1Database, input: { key: string; value: unknown; version: number; reason: string; now: number }): Promise<Setting> {
  const { key, version, reason, now } = input;
  const name = key.startsWith(DEFAULT_PREFIX) ? key.slice(DEFAULT_PREFIX.length) : "";
  // 基準と GitHub のルールはパスキーの確認が要る専用のルートで変えるので、ここでは扱わない
  if (!isInheritedKey(name)) throw new AppError("not_found", "このルートで変えられる設定の項目でない");
  const value = checkValue(INHERITED_SETTINGS[name], input.value);
  if ((await loadOfficeDefaults(db))[name].version !== version) throw new AppError("conflict", "バージョンが違う");
  const next = version + 1;
  const written = await drizzle(db)
    .insert(settings)
    .select(
      sql`SELECT ${newId(clockAt(now))}, ${key}, 'office', ${JSON.stringify(value)}, ${next}, 'owner', ${reason}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${settings} WHERE ${settings.key} = ${key} AND ${settings.scope} = 'office' AND ${settings.version} >= ${next})`,
    )
    .returning({ id: settings.id });
  if (written.length === 0) throw new AppError("conflict", "バージョンが違う");
  return { key, value, inherited: false, version: next };
}
