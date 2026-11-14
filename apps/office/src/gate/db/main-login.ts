// D1 の DB のうち、ログインと記録のテーブル。データの 2.1
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { flag, id, json, time } from "./columns.ts";

// 2.1 ログインと記録

/** ログインセッション。トークンは SHA-256 だけを持つ */
export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    createdAt: time("created_at").notNull(),
    lastSeenAt: time("last_seen_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    endedAt: time("ended_at"),
    stepUpUntil: time("step_up_until"),
    ip: text("ip").notNull(),
    country: text("country"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_token_hash").on(t.tokenHash)],
);

/** 登録したパスキー。人に見せてよい側の鍵だけ */
export const passkeys = sqliteTable("passkeys", {
  id: id(),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull(),
  transports: json("transports"),
  createdAt: time("created_at").notNull(),
  lastUsedAt: time("last_used_at"),
});

/** ログインとパスキーの確認の試み。追記専用 */
export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: id(),
    at: time("at").notNull(),
    ip: text("ip").notNull(),
    country: text("country"),
    kind: text("kind", { enum: ["access", "passkey"] }).notNull(),
    ok: flag("ok").notNull(),
    reason: text("reason"),
  },
  (t) => [index("login_attempts_ip_at").on(t.ip, t.at)],
);

/** 年ごとの記録の置き場。記録 DO だけが書く */
export const recordYears = sqliteTable("record_years", {
  year: integer("year").primaryKey(),
  binding: text("binding").notNull(),
  state: text("state", { enum: ["writing", "readonly"] }).notNull(),
  firstHash: text("first_hash"),
  lastHash: text("last_hash"),
});

/** 実行中に作る鍵。MASTER_KEY で AES-GCM の暗号にする */
export const vault = sqliteTable(
  "vault",
  {
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    version: integer("version").notNull(),
    createdAt: time("created_at").notNull(),
    revokedAt: time("revoked_at"),
  },
  (t) => [primaryKey({ columns: [t.name, t.version] })],
);

/** 部分ごとの稼働確認。追記専用 */
export const healthChecks = sqliteTable("health_checks", {
  id: id(),
  at: time("at").notNull(),
  part: text("part").notNull(),
  ok: flag("ok").notNull(),
  ms: integer("ms").notNull(),
});
