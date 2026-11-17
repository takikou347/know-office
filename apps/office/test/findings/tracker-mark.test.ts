// Issue の本文の隠した印 (指紋と設計書から作った Issue の鍵) が、公開の文を伏せる包みを通っても残る事
import { describe, expect, it } from "vitest";
import { UNCONNECTED_DEV_ISSUES } from "../../src/gate/devloop/dev-issues.ts";
import { devIssueKeyOf, devIssueMark, fingerprintMark, publicDevIssues, publicTracker, UNCONNECTED_TRACKER } from "../../src/gate/findings/tracker.ts";

const HEX = "ab12".repeat(16);

describe("隠した印", () => {
  it("印が publicTracker を通っても残る。ほかの 16 進数の長い続きは伏せる", async () => {
    const seen: { title: string; body: string }[] = [];
    const tracker = publicTracker({
      ...UNCONNECTED_TRACKER,
      createIssue: (_repo, input) => {
        seen.push(input);
        return Promise.resolve(1);
      },
    });
    await tracker.createIssue("example/r", { title: "題", body: `連絡 a@example.com\n${fingerprintMark(HEX)}\n${devIssueMark(HEX)}\n別の ${"cd34".repeat(8)}` });
    expect(seen[0]?.body).toContain(fingerprintMark(HEX));
    expect(seen[0]?.body).toContain(devIssueMark(HEX));
    expect(seen[0]?.body).not.toContain("a@example.com");
    expect(seen[0]?.body).not.toContain("cd34cd34");
  });

  it("印が publicDevIssues を通っても残り、コメントの印も残る", async () => {
    const seen: string[] = [];
    const issues = publicDevIssues({
      ...UNCONNECTED_DEV_ISSUES,
      createIssue: (_repo, input) => {
        seen.push(input.title, input.body);
        return Promise.resolve({ number: 1, id: 1 });
      },
      comment: (_repo, _n, body) => {
        seen.push(body);
        return Promise.resolve();
      },
    });
    await issues.createIssue("example/r", { title: "鍵 sk-abc", body: `本文\n${devIssueMark(HEX)}`, labels: [] });
    await issues.comment("example/r", 1, `閉じる sk-abc\n${devIssueMark(HEX)}`);
    expect(seen[0]).not.toContain("sk-abc");
    expect(seen[1]).toContain(devIssueMark(HEX));
    expect(seen[2]).toContain(devIssueMark(HEX));
    expect(seen[2]).not.toContain("sk-abc");
  });

  it("本文から鍵を読む。印が無ければ null", () => {
    expect(devIssueKeyOf(`本文\n${devIssueMark(HEX)}`)).toBe(HEX);
    expect(devIssueKeyOf(fingerprintMark(HEX))).toBeNull();
    expect(devIssueKeyOf(null)).toBeNull();
  });
});
