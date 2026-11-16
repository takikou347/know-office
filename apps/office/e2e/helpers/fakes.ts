// 開発の代わりの物 (Access、Claude API、GitHub) の宛先。ゲートウェイと同じ .dev.vars の DEV_FAKES_URL から読む
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDevVars } from "../../dev/plugin.ts";

/** 手元の代わりの物の宛先。作業ツリーごとにポートが違うので、決まった番号を書かない */
export const FAKES = `http://127.0.0.1:${parseDevVars(readFileSync(join(import.meta.dirname, "../../.dev.vars"), "utf8")).port}`;
