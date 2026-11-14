// GitHub Pages に置く API の文書 (Swagger UI と v1.yaml) を 1 つのフォルダにそろえる
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const openapi = join(here, "../openapi");
const swagger = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

/**
 * Swagger UI のファイル、ページ、v1.yaml を出力先に写す
 * @param out 出力先のフォルダ
 * @returns 写し終わったら解決する
 */
export async function buildApiDocs(out: string): Promise<void> {
  await mkdir(out, { recursive: true });
  const files: [string, string][] = [
    [join(openapi, "v1.yaml"), "v1.yaml"],
    [join(openapi, "pages/index.html"), "index.html"],
    [join(openapi, "pages/swagger-init.js"), "swagger-init.js"],
    [join(swagger, "swagger-ui.css"), "swagger-ui.css"],
    [join(swagger, "swagger-ui-bundle.js"), "swagger-ui-bundle.js"],
  ];
  await Promise.all(files.map(([from, to]) => copyFile(from, join(out, to))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildApiDocs(process.argv[2] ?? join(here, "../dist-api-docs"));
}
