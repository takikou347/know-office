// core のスキーマが使う Zod。作る前に .openapi() を足しておき、ゲートウェイが components に登録できるようにする
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Zod 4 は作った時に持つメソッドが決まるので、スキーマを作るより先に足す。2 回目以降の呼び出しは何もしない
extendZodWithOpenApi(z);

export { z };
