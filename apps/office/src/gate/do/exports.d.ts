// ctx.exports の型。Worker の入口が出す物から作る (workers-types の GlobalProps)
import type * as Main from "../worker.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      /** Worker の入口 */
      mainModule: typeof Main;
    }
  }
}
