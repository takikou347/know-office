// DB のマイグレーションを作る設定。データの 1 章
import { defineConfig } from "drizzle-kit";

export default defineConfig({ dialect: "sqlite", schema: ["./src/gate/db/main-login.ts", "./src/gate/db/main-work.ts", "./src/gate/db/main-tasks.ts"], out: "./migrations/main" });
