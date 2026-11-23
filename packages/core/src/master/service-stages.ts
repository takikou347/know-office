// サービスの段階のマスタデータ。アイデアから運用までの順に並べ、見送りと閉じたを後ろに置く (サービスと拡張の 3.1)
import { defineMaster } from "./master.ts";

/** サービスの段階 */
export const SERVICE_STAGES = defineMaster([
  { value: "idea", label: "アイデア" },
  { value: "study", label: "検討" },
  { value: "prototype", label: "試作" },
  { value: "service", label: "サービス" },
  { value: "operation", label: "運用" },
  { value: "dropped", label: "見送った" },
  { value: "closed", label: "閉じた" },
]);
