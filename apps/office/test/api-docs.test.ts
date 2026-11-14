import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApiDocs } from "../scripts/api-docs.ts";

describe("GitHub Pages に置く API の文書", () => {
  it("Swagger UI のファイルと v1.yaml を 1 つのフォルダにそろえる", async () => {
    const out = await mkdtemp(join(tmpdir(), "api-docs-"));
    await buildApiDocs(out);
    const files = await readdir(out);
    expect(files).toEqual(expect.arrayContaining(["index.html", "swagger-init.js", "swagger-ui.css", "swagger-ui-bundle.js", "v1.yaml"]));
    const yaml = await readFile(join(out, "v1.yaml"), "utf8");
    expect(yaml).toContain("openapi: 3.1.0");
  });

  it("画面は外の CDN と検証サービスを読まず、試しに送るボタンを出さない", async () => {
    const out = await mkdtemp(join(tmpdir(), "api-docs-"));
    await buildApiDocs(out);
    const html = await readFile(join(out, "index.html"), "utf8");
    expect(html).not.toMatch(/https?:\/\//);
    const init = await readFile(join(out, "swagger-init.js"), "utf8");
    expect(init).toContain('url: "v1.yaml"');
    expect(init).toContain("supportedSubmitMethods: []");
    expect(init).toContain("validatorUrl: null");
    expect(init).not.toMatch(/https?:\/\//);
  });
});
