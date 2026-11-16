// どのテストのファイルにも入る前後の処理。isolate を切って 1 つの worker で多くのファイルを続けて流すので、ファイルごとの片付けとテストごとの戻しをここに置く
import { afterAll, beforeEach } from "vitest";
import { endFile } from "./helpers/file-end.ts";
import { resetKeys } from "./helpers/keys.ts";

// テストごとに頭の鍵から渡し直す。同じテストの中では同じ鍵を 2 度渡さない
beforeEach(resetKeys);
// ファイルで 1 つ起こした D1 と DO の workerd を止める
afterAll(endFile);
