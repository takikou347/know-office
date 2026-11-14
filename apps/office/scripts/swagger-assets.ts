// ゲートウェイの /api/v1/docs が読む Swagger UI のファイルを、画面のファイルの置き場に写す
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const swagger = dirname(createRequire(import.meta.url).resolve("swagger-ui-dist/package.json"));

/**
 * swagger-ui-dist の CSS と JS を public/swagger に写す
 * @param out 出力先のフォルダ
 * @returns 写し終わったら解決する
 */
export async function copySwaggerAssets(out: string): Promise<void> {
  await mkdir(out, { recursive: true });
  await Promise.all(["swagger-ui.css", "swagger-ui-bundle.js"].map((f) => copyFile(join(swagger, f), join(out, f))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await copySwaggerAssets(join(here, "../public/swagger"));
}
