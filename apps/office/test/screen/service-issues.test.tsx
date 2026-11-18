// サービスの Issue の木の画面。親ごとに子の済みを出し、サービスに進められる時に知らせる (開発の回し方の 3.7)
import type { ServiceIssues } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceIssuesBody, ServiceIssuesList } from "../../src/screen/pages/services/ServiceIssuesView.tsx";

const TASK = "0190f4a8-0000-7000-8000-000000000001";

/**
 * 木を作る
 * @param change 変える所
 * @returns 木
 */
function tree(change: Partial<ServiceIssues> = {}): ServiceIssues {
  return {
    ready: false,
    docsPrs: [],
    parents: [
      {
        number: 1,
        feature: "1-video",
        state: "open",
        operations: false,
        children: [
          { number: 2, requirement: "動画を作る", kind: "feature", state: "closed", task: { id: TASK, status: "done", prNumber: 7 } },
          { number: 3, requirement: "動画を見る", kind: "bug", state: "open", task: { id: TASK, status: "doing", prNumber: null } },
        ],
      },
      { number: 4, feature: "operations", state: "open", operations: true, children: [] },
    ],
    ...change,
  };
}

describe("リリースと運用につなぐ", () => {
  it("木が空なら、設計書から Issue をまだ作っていない事を出す", () => {
    const html = renderToString(<ServiceIssuesList issues={tree({ parents: [] })} stage="prototype" name="動画" />);
    expect(html).toContain("Issue はまだ無い");
  });

  it("親ごとに、子の要件と済みの数を出す。運用の親は運用と書く", () => {
    const html = renderToString(<ServiceIssuesList issues={tree()} stage="prototype" name="動画" />);
    expect(html).toContain("1-video");
    expect(html).toContain("1 / 2 済");
    expect(html).toContain("動画を作る");
    expect(html).toContain("動画を見る");
    expect(html).toContain("PR #7");
    expect(html).toContain("運用");
  });

  it("設計書の PR を並べる", () => {
    const html = renderToString(<ServiceIssuesList issues={tree({ docsPrs: [{ repo: "example/docs", number: 41, kind: "design", task: { id: TASK, status: "review" } }] })} stage="prototype" name="動画" />);
    expect(html).toContain("設計書の PR");
    expect(html).toContain("example/docs#41");
  });

  it("試作で ready なら、サービスに進められると知らせる。試作でなければ知らせない", () => {
    expect(renderToString(<ServiceIssuesList issues={tree({ ready: true })} stage="prototype" name="動画" />)).toContain("サービスに進められる");
    expect(renderToString(<ServiceIssuesList issues={tree({ ready: true })} stage="service" name="動画" />)).not.toContain("サービスに進められる");
    expect(renderToString(<ServiceIssuesList issues={tree({ ready: false })} stage="prototype" name="動画" />)).not.toContain("サービスに進められる");
  });

  it("読めなければ、読めなかった事と問い合わせの番号を出す", () => {
    const html = renderToString(<ServiceIssuesBody loaded={{ state: "failed", code: "network", traceId: "a".repeat(32) }} stage="prototype" name="動画" />);
    expect(html).toContain("Issue を読めませんでした");
    expect(html).toContain("a".repeat(32));
    expect(html).not.toContain("Issue はまだ無い");
  });
});
