// 段階を移せなかった時の表示。デプロイの条件が足りない時は、足りない条件を出す (サービスと拡張の 3.1)
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoveFailure } from "../../src/screen/pages/services/StageActions.tsx";

describe("段階ごとのオーナーの判断", () => {
  describe("段階を移せなかった時の表示", () => {
    it("conflict の説明 (足りない条件) を出す", () => {
      const html = renderToString(<MoveFailure failure={{ code: "conflict", traceId: "t1", detail: "デプロイの条件を満たしていない。足りない条件: reviewer (レビュー担当が既定のブランチの先のコミットを承認していない)" }} />);
      expect(html).toContain("段階を移せませんでした");
      expect(html).toContain("足りない条件: reviewer");
      // 読み上げる Alert の中に入っている
      expect(html).toMatch(/role="alert"[^]*足りない条件: reviewer/);
    });

    it("説明の無い失敗と、conflict でない失敗は、説明を出さない", () => {
      expect(renderToString(<MoveFailure failure={{ code: "conflict", traceId: "t1" }} />)).not.toContain("<p>");
      expect(renderToString(<MoveFailure failure={{ code: "upstream_failed", traceId: "t1", detail: "内部の説明" }} />)).not.toContain("内部の説明");
    });
  });
});
