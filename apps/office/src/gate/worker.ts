// Worker の入口。ゲートウェイと Durable Objects のクラスを出す。wrangler の main はここ
import gate from "./index.ts";

export { RecorderDO } from "./do/recorder.ts";

export default gate;
