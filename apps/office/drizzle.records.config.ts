// REC_<年> のマイグレーションを作る設定。データの 2 章
import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "sqlite", schema: "./src/gate/db/records.ts", out: "./migrations/ledger" });
