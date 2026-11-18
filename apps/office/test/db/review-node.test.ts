// レビューの行を作った社員のタスクごとに 1 行にするマイグレーション (0021_review_node) が、消す行を指す指摘と GitHub への写しを残す行へ付け替える事を確かめる (タスクとレビューの 3.1)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "../helpers/d1.ts";

const MIGRATION = join(import.meta.dirname, "../../migrations/main/0021_review_node.sql");
const NODE = "019a7b00-0000-7000-8000-000000000001";
const OTHER = "019a7b00-0000-7000-8000-000000000002";
const OLD = "019a7b00-0000-7000-8000-0000000000a1";
const NEW = "019a7b00-0000-7000-8000-0000000000a2";
const ALONE = "019a7b00-0000-7000-8000-0000000000a3";

let d1: TestD1;
beforeAll(async () => {
  d1 = await createTestD1();
});
afterAll(() => d1.dispose());

/**
 * マイグレーションのファイルを、手元の D1 のマイグレーションと同じく文ごとに流す
 */
async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  for (const sql of statements) await d1.DB.prepare(sql).run();
}

describe("別のモデルによる確認", () => {
  it("重なったレビューの行を 1 行にするマイグレーションは、消す行の指摘と GitHub への写しを残す行へ付け替える", async () => {
    const db = d1.DB;
    // マイグレーションの前の形に戻し、前の出し直しが足した重なりを置く
    await db.prepare("DROP INDEX reviews_node").run();
    const review = db.prepare("INSERT INTO reviews (id, node_id, repo, pr_number, branch, base_sha, head_sha) VALUES (?, ?, 'o/r', 1, 'ko/x', ?, ?)");
    await db.batch([
      review.bind(OLD, NODE, "a".repeat(40), "b".repeat(40)),
      review.bind(NEW, NODE, "a".repeat(40), "c".repeat(40)),
      review.bind(ALONE, OTHER, "a".repeat(40), "d".repeat(40)),
      db.prepare("INSERT INTO review_notes (id, review_id, at, by, path, line, side, body) VALUES ('n1', ?, 1, 'owner', 'a.ts', 1, 'RIGHT', '前の指摘')").bind(OLD),
      db.prepare("INSERT INTO review_notes (id, review_id, at, by, path, line, side, body) VALUES ('n2', ?, 2, 'owner', 'a.ts', 2, 'RIGHT', '別の指摘')").bind(ALONE),
      db.prepare("INSERT INTO github_mirrors (id, review_id, kind, payload, created_at) VALUES ('m1', ?, 'comment', '{}', 1)").bind(OLD),
    ]);
    await runMigration();
    expect((await db.prepare("SELECT id FROM reviews ORDER BY id").all()).results).toEqual([{ id: NEW }, { id: ALONE }]);
    expect((await db.prepare("SELECT id, review_id FROM review_notes ORDER BY id").all()).results).toEqual([
      { id: "n1", review_id: NEW },
      { id: "n2", review_id: ALONE },
    ]);
    expect((await db.prepare("SELECT id, review_id FROM github_mirrors").all()).results).toEqual([{ id: "m1", review_id: NEW }]);
    // 指摘は追記だけの守りを付け直している
    await expect(db.prepare("UPDATE review_notes SET body = 'x'").run()).rejects.toThrow(/append only/);
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'reviews_node'").first()).toEqual({ name: "reviews_node" });
  });
});
