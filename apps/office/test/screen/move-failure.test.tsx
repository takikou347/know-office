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

    it("決まりで断った refused は、ほかで変わったと言わず、足りない事 (detail) を出す", () => {
      const html = renderToString(<MoveFailure failure={{ code: "refused", traceId: "t1", detail: "同じ名前 (video-maker) のリポジトリを持つサービスがあり、設計書の置き場 services/video-maker/ が重なる。名前の違うリポジトリを選ぶ" }} />);
      expect(html).toContain("名前の違うリポジトリを選ぶ");
      expect(html).not.toContain("ほかの所で先に変わりました");
      // ほかで変わった conflict は、ほかで変わったと出す
      expect(renderToString(<MoveFailure failure={{ code: "conflict", traceId: "t1", detail: "段階か GitHub との連携か、デプロイの条件が変わった" }} />)).toContain("ほかの所で先に変わりました");
    });
  });
});
