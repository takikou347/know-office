// ダッシュボードの、オーナーの判断を待つレビュー。main に入れる条件にオーナーの承認があり、レビュー担当が承認した物だけを古い順に返す (タスクとレビューの 3.4、GitHub の連携の 3.3)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { fixedClock } from "../helpers/clock.ts";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";
import { createTestGate, type TestGate } from "../helpers/gate.ts";

const at = (day: number, h: number) => Date.UTC(2026, 10, day, h - 9);

let d1: TestD1;
let gate: TestGate;
let headers: Record<string, string>;
beforeEach(async () => {
  d1 = await createTestD1();
  gate = await createTestGate({ clock: fixedClock(at(16, 10)), d1 });
  headers = await gate.signIn();
});
afterEach(() => d1.dispose());

const OWNER_REPO = "example/needs-owner";
const PLAIN_REPO = "example/plain";
const SERVICE = "019a7b00-0000-7000-8000-0000000000d1";

/**
 * 番号から UUID v7 の形の ID を作る
 * @param n 番号
 * @returns ID
 */
const idOf = (n: number) => `019a7b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** 作った社員のタスクとレビューの行の置き方 */
type Made = { n: number; repo: string; title: string; status?: string; reviewer?: string | null; owner?: string | null; mergedAt?: number | null; updatedAt?: number };

/**
 * main に入れる条件にオーナーの承認を持つサービスを置く
 * @param repo サービスのリポジトリ
 */
async function ownerService(repo: string): Promise<void> {
  await d1.DB.batch([
    d1.DB.prepare("INSERT INTO services (id, name, kind, stage, repo, staff_id, created_at) VALUES (?, 'オーナーが見るサービス', 'web_app', 'prototype', ?, 'builder', 1)").bind(SERVICE, repo),
    d1.DB.prepare("INSERT INTO service_settings (id, service_id, key, value, version, by, created_at) VALUES (?, ?, 'mergeWhen', '[\"checks\",\"reviewer\",\"owner\"]', 1, 'owner', 1)").bind(idOf(0xd2), SERVICE),
  ]);
}

/**
 * 開発担当のタスクと、そのレビューの行を置く
 * @param rows 置く物
 */
async function made(rows: Made[]): Promise<void> {
  await d1.DB.batch(
    rows.flatMap((r) => [
      d1.DB.prepare(
        "INSERT INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, repo, branch, pr_number, created_by, created_at, updated_at) VALUES (?, 'task', NULL, 'office', ?, NULL, 'build', 'builder', ?, 1, ?, ?, ?, 'president', 1, ?)",
      ).bind(idOf(r.n), r.title, r.status ?? "review", r.repo, `ko/${String(r.n)}`, r.n, r.updatedAt ?? r.n),
      d1.DB.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha, checks, reviewer_summary, reviewer_verdict, owner_verdict, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '確かめた', ?, ?, ?)").bind(
        idOf(0x1000 + r.n),
        idOf(r.n),
        r.repo,
        r.n,
        `ko/${String(r.n)}`,
        "a".repeat(40),
        "b".repeat(40),
        r.reviewer === undefined ? "approve" : r.reviewer,
        r.owner ?? null,
        r.mergedAt ?? null,
      ),
    ]),
  );
}

const Reviews = z.object({ data: z.object({ ownerReviews: z.array(z.object({ nodeId: z.string(), title: z.string(), assignee: z.string().nullable(), repo: z.string(), prNumber: z.number(), requestedAt: z.string() }).strict()) }).loose() });

/**
 * ダッシュボードのオーナーの判断を待つレビューを読む
 * @returns 返したレビュー
 */
async function ownerReviews(): Promise<z.infer<typeof Reviews>["data"]["ownerReviews"]> {
  const res = await gate.request("/api/v1/dashboard", { headers });
  expect(res.status).toBe(200);
  return Reviews.parse(await res.json()).data.ownerReviews;
}

describe("know-office の中で確認する", () => {
  it("オーナーの承認を待つレビューは、ダッシュボードの承認を待つ物に出る", async () => {
    await ownerService(OWNER_REPO);
    await made([{ n: 2, repo: OWNER_REPO, title: "後に頼んだ直し", updatedAt: at(16, 9) }, { n: 1, repo: OWNER_REPO, title: "先に頼んだ直し", updatedAt: at(15, 9) }]);
    expect(await ownerReviews()).toEqual([
      { nodeId: idOf(1), title: "先に頼んだ直し", assignee: "builder", repo: OWNER_REPO, prNumber: 1, requestedAt: new Date(at(15, 9)).toISOString() },
      { nodeId: idOf(2), title: "後に頼んだ直し", assignee: "builder", repo: OWNER_REPO, prNumber: 2, requestedAt: new Date(at(16, 9)).toISOString() },
    ]);
  });

  it("オーナーの承認が条件に無いリポジトリ、レビュー担当がまだ承認していない物、オーナーが決めた物、入れた物、レビューを待っていない物は出さない", async () => {
    await ownerService(OWNER_REPO);
    await made([
      { n: 1, repo: PLAIN_REPO, title: "条件にオーナーが無い" },
      { n: 2, repo: OWNER_REPO, title: "レビュー担当がまだ", reviewer: null },
      { n: 3, repo: OWNER_REPO, title: "レビュー担当が差し戻した", reviewer: "reject" },
      { n: 4, repo: OWNER_REPO, title: "オーナーが承認した", owner: "approve" },
      { n: 5, repo: OWNER_REPO, title: "入れた", mergedAt: 9 },
      { n: 6, repo: OWNER_REPO, title: "作り直している", status: "todo" },
      { n: 7, repo: OWNER_REPO, title: "待っている" },
    ]);
    expect((await ownerReviews()).map((r) => r.title)).toEqual(["待っている"]);
  });

  it("オーナーの判断を待つレビューは 100 件ちょうどまで返し、101 件目は返さない", async () => {
    await ownerService(OWNER_REPO);
    await made(Array.from({ length: 101 }, (_, i) => ({ n: i + 1, repo: OWNER_REPO, title: `直し ${String(i + 1)}` })));
    const got = await ownerReviews();
    expect(got).toHaveLength(100);
    expect(got[0]?.title).toBe("直し 1");
    expect(got.map((r) => r.title)).not.toContain("直し 101");
  });

  it("オーナーの判断を待つレビューが無ければ、空の並びを返す", async () => {
    expect(await ownerReviews()).toEqual([]);
  });
});
