import { defineConfig } from "vitest/config";

// 作ったイメージを Docker で確かめる。WORKSPACE_IMAGE でイメージを替える
export default defineConfig({ test: { include: ["test/image/**/*.test.ts"], testTimeout: 60_000 } });
