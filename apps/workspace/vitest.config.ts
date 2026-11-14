import { configDefaults, defineConfig } from "vitest/config";

// イメージのテストは Docker が要るので、test:image で別に流す
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "test/image/**"] } });
