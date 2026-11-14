import { configDefaults, defineConfig } from "vitest/config";

// イメージのテストは Docker が要るので、test:image で別に流す
// 本物の SDK を起こすテストは、初めて起こす時と混んだ時に 5 秒を超えるので 30 秒まで待つ。1 つのテストで SDK を起こすのは 2 回までにする
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "test/image/**"], testTimeout: 30_000 } });
