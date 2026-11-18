// ダッシュボードの承認を待つ物と、決める画面の 409 の見分け。件数、1 件ずつの道、一覧への道を出す (タスクとレビューの 3.4)
import type { Approval } from "@know-office/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createApi } from "../../src/screen/api.ts";
import { stillPending } from "../../src/screen/pages/approvals/pending.ts";
import { WaitingList, WaitingStat } from "../../src/screen/pages/approvals/Waiting.tsx";

const ID = "0190f4a8-0000-7000-8000-000000000001";
const OTHER = "0190f4a8-0000-7000-8000-000000000002";

/**
 * 承認を 1 件作る
 * @param id 承認 ID
 * @returns 承認
 */
function approval(id: string): Approval {
  return { id, kind: "external_integration", target: "Slack", payload: { reason: "通知を送る" }, status: "pending", requestedBy: "builder", requestedAt: "2026-11-15T01:00:00.000Z", decidedAt: null, reason: null };
}

/**
 * 決めていない承認の一覧を返す口を作る
 * @param pages ページごとの承認 ID。最後のページの次は無い
 * @returns 口
 */
function apiWith(pages: string[][]) {
  return createApi("http://localhost", (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const page = Number(url.searchParams.get("cursor") ?? "0");
    const next = page + 1 < pages.length ? String(page + 1) : null;
    return Promise.resolve(Response.json({ data: (pages[page] ?? []).map(approval), meta: { traceId: "b".repeat(32), next } }));
  });
}

describe("承認を決める画面", () => {
  it("承認を待つ物が 0 件なら、件数は 0 で、一覧は無い事を出す", () => {
    const pending = { state: "ok" as const, data: [] };
    const stat = renderToString(<WaitingStat pending={pending} />);
    expect(stat).toContain('ki-stat__num">0<');
    const list = renderToString(<WaitingList pending={pending} />);
    expect(list).toContain("承認を待つ物は無い");
    expect(list).toContain('href="/approvals"');
  });

  it("承認を待つ物が 1 件なら、その 1 件を決める画面への道を出す", () => {
    const pending = { state: "ok" as const, data: [approval(ID)] };
    expect(renderToString(<WaitingStat pending={pending} />)).toContain('ki-stat__num">1<');
    const list = renderToString(<WaitingList pending={pending} />);
    expect(list).toContain(`href="/approvals/${ID}"`);
    expect(list).toContain("外部連携: Slack");
    expect(list).toContain("すべて見る");
  });

  it("読めなければ件数を出さず、読めなかった事を出す", () => {
    const pending = { state: "failed" as const, code: "network", traceId: null };
    expect(renderToString(<WaitingStat pending={pending} />)).toContain("読めませんでした");
    expect(renderToString(<WaitingList pending={pending} />)).toContain("承認を待つ物を読めませんでした");
  });

  it("409 の後に、並びから消えた時だけ先に決まったと見なし、続きのページも読む", async () => {
    expect(await stillPending(apiWith([[OTHER], [ID]]), ID)).toBe(true);
    expect(await stillPending(apiWith([[OTHER], []]), ID)).toBe(false);
    // 読めない時は先に決まったと言わない
    const broken = createApi("http://localhost", () => Promise.resolve(new Response("x", { status: 500 })));
    expect(await stillPending(broken, ID)).toBe(true);
  });
});
