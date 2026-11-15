// オーナーが行に書いた指摘が、作った社員のタスクに戻り、GitHub のプルリクエストの行のコメントに写る (タスクとレビューの 3.6、要件 review の指摘)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, rows, useWork } from "../helpers/work.ts";
import { eventsOf, HEAD, marked, openReview, postedTo, sameBatch, spyBatches } from "../helpers/review.ts";

const world = useWork();

const NOTE = { path: "src/attendance.ts", line: 12, side: "new", body: "空の日は 0 を出す" };

describe("指摘", () => {
  it("指摘がタスクに戻る", async () => {
    const { task } = await openReview(world);
    const res = await world.gate.request(`/api/v1/reviews/${task}/notes`, { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify(NOTE) });
    expect(res.status).toBe(201);
    const note = z.object({ data: z.object({ id: z.string(), by: z.string(), path: z.string(), line: z.number(), side: z.string(), body: z.string(), at: z.string() }).strict() }).loose().parse(await res.json()).data;
    expect(note).toMatchObject({ by: "owner", ...NOTE });
    expect(res.headers.get("Location")).toBe(`/api/v1/reviews/${task}/notes/${note.id}`);
    const events = await eventsOf(world, task);
    expect(events.find((e) => e.kind === "review_note")).toEqual({ kind: "review_note", staffId: null, detail: { by: "owner", noteId: note.id, path: NOTE.path, line: NOTE.line, side: "new", body: NOTE.body } });
    // 戻ったタスクは、手の空いた開発担当がすぐに取る
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", task)).toEqual([{ status: "doing" }]);
    expect(postedTo(world, "comments")).toEqual([{ body: marked("オーナー: 空の日は 0 を出す"), commit_id: HEAD, path: NOTE.path, line: 12, side: "RIGHT" }]);
    expect(await rows(world.d1.DB, "SELECT kind, sent_at IS NOT NULL AS sent FROM github_mirrors")).toEqual([{ kind: "comment", sent: 1 }]);
  });

  it("前の行への指摘は GitHub の LEFT に写る", async () => {
    const { task } = await openReview(world);
    await api(world, "POST", `/api/v1/reviews/${task}/notes`, { ...NOTE, side: "old" }, 201);
    expect(postedTo(world, "comments")).toMatchObject([{ side: "LEFT" }]);
  });

  it("ファイルの道の形が違えば 422 で何も残さない", async () => {
    const { task } = await openReview(world);
    for (const path of ["/etc/passwd", "src/../x.ts", "src//x.ts", "src/x.ts/", "a\u0000b"]) {
      expect(await api(world, "POST", `/api/v1/reviews/${task}/notes`, { ...NOTE, path }, 422)).toMatchObject({ code: "validation_failed" });
    }
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM review_notes")).toEqual([{ n: 0 }]);
    expect(postedTo(world, "comments")).toEqual([]);
  });

  it("指摘と写す順番待ちは 1 回のバッチで書き、片方だけ残さない", async () => {
    const { task } = await openReview(world);
    // 順番待ちの行が書けない D1 の代わりに、テーブルを消しておく
    await world.d1.DB.prepare("ALTER TABLE github_mirrors RENAME TO github_mirrors_gone").run();
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/notes`, NOTE, 500);
    } finally {
      await world.d1.DB.prepare("ALTER TABLE github_mirrors_gone RENAME TO github_mirrors").run();
    }
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM review_notes")).toEqual([{ n: 0 }]);
    expect(postedTo(world, "comments")).toEqual([]);
  });

  it("指摘と、作った社員のタスクを todo に戻すのは 1 回のバッチで書く", async () => {
    const { task } = await openReview(world);
    const spy = spyBatches(world);
    try {
      await api(world, "POST", `/api/v1/reviews/${task}/notes`, NOTE, 201);
    } finally {
      spy.restore();
    }
    expect(sameBatch(spy.batches, "INSERT INTO review_notes", "INSERT INTO github_mirrors", "UPDATE nodes SET status = 'todo'")).toBe(true);
  });
});
