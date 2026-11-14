// テストの前に Zod に .openapi() を足す。テストのファイルが core のスキーマを先に読むと、後から読むゲートウェイが登録できないため
import { extendZodWithOpenApi } from "@hono/zod-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);
