// 本番と同じ vite の組み立てで、extensions/ の拡張がゲートウェイに入る事を確かめる。vitest は組み立てを通らないので、ここで組んで素の node で読み込む (サービスと拡張の 3.8)
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const root = join(import.meta.dirname, "../..");
const out = mkdtempSync(join(tmpdir(), "know-office-ext-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("拡張の組み立て", () => {
  it("vite build で組んだゲートウェイに見本の拡張が入る", async () => {
    await build({
      root,
      configFile: false,
      logLevel: "error",
      // 依存も一緒に組み、組んだ物だけで読み込めるようにする
      ssr: { noExternal: true },
      build: { ssr: join(root, "src/gate/extensions/installed.ts"), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: "installed.mjs" } } },
    });
    // vitest の中で import すると vitest が import.meta を足すので、組んだ物は素の node で読み込む
    const url = pathToFileURL(join(out, "installed.mjs")).href;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify(m.INSTALLED.map((e) => e.id)));`], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(z.array(z.string()).parse(JSON.parse(run.stdout))).toContain("sample-notes");
  }, 30_000);
});
