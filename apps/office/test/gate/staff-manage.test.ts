// 社員の追加、設定、削除のルート。書く条件を 1 文に入れ、同時の 2 回と読んだ後の変更で崩れない事を確かめる (タスクとレビューの 3.4)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claimNode } from "../../src/gate/work/loop.ts";
import { type Actor, createNode, findNode, intakeProject } from "../../src/gate/work/nodes.ts";
import { planDay } from "../../src/gate/work/plan.ts";
import { handOverLeftovers } from "../../src/gate/work/staff-manage.ts";
import { issueTicket, workspaceIdOf } from "../../src/gate/work/ticket.ts";
import { api, at, MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork();

const Staff = z.object({ id: z.string(), job: z.string(), role: z.string(), bossId: z.string().nullable(), model: z.string(), version: z.number(), schedule: z.unknown() }).loose();

/**
 * 今のログインセッションでパスキーを確かめた事にする
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * 社員を足す
 * @param w テストの物
 * @param body 入力
 * @param status 待つステータス
 * @returns 足した社員
 */
async function hire(w: WorkWorld, body: Record<string, unknown> = {}, status = 201): Promise<z.infer<typeof Staff>> {
  const res = await api(w, "POST", "/api/v1/staff", { job: "builder", role: "開発担当 2", bossId: "president", model: "claude-sonnet-5-5", ...body }, status);
  return status === 201 ? Staff.parse(res) : Staff.parse({ id: "", job: "", role: "", bossId: null, model: "", version: 0, schedule: null });
}

/**
 * 在籍の社員の ID を並べる
 * @param w テストの物
 * @returns 社員 ID
 */
async function roster(w: WorkWorld): Promise<string[]> {
  return z.array(Staff).parse(await api(w, "GET", "/api/v1/staff")).map((s) => s.id);
}

/**
 * office の受け付けの下に、担当付きのタスクを足す
 * @param w テストの物
 * @param assignee 担当
 * @returns タスクの ID
 */
async function task(w: WorkWorld, assignee: string): Promise<string> {
  const actor: Actor = { by: "owner", now: w.clock.now() };
  const project = await intakeProject(w.gate.env, "office", actor);
  return (await createNode(w.gate.env, { kind: "task", parentId: project.id, scope: "office", title: "移すタスク", taskKind: "build", assignee }, actor)).id;
}

/**
 * 社員を削除する
 * @param w テストの物
 * @param path 社員のパス
 * @param status 待つステータス
 */
async function retire(w: WorkWorld, path: string, status: number): Promise<void> {
  const res = await w.gate.request(path, { method: "DELETE", headers: w.headers });
  expect({ status: res.status, body: res.status === 204 ? null : await res.text() }).toMatchObject({ status });
}

describe("社員を追加し、削除し、設定する", () => {
  it("社員を追加すると一覧と組織図に出て、出勤の予定が組まれる", async () => {
    await stepUp(world);
    const made = await hire(world);
    expect(made).toMatchObject({ job: "builder", role: "開発担当 2", bossId: "president", model: "claude-sonnet-5-5", version: 1, schedule: null });
    expect(made.id).toMatch(/^builder-[a-z0-9]{6}$/);
    expect(await roster(world)).toEqual(["president", "builder", "reviewer", made.id]);
    const org = z.array(z.object({ id: z.string(), prompt: z.string() }).loose()).parse(await api(world, "GET", "/api/v1/org"));
    const base = org.find((p) => p.id === "builder")?.prompt;
    expect(org.find((p) => p.id === made.id)?.prompt).toBe(base);
    expect(await planDay(world.d1.DB, made.id, "2026-12-01")).not.toBeNull();
    expect(world.gate.audits).toContainEqual(expect.objectContaining({ action: "staff.create", target: made.id }));
  });

  it("社員を追加する時はパスキーの確認を求める", async () => {
    await hire(world, {}, 401);
    expect(await roster(world)).toEqual(["president", "builder", "reviewer"]);
  });

  it("社長は追加できず、上司は在籍の社員だけを選べ、在籍は 10 人まで", async () => {
    await stepUp(world);
    await hire(world, { job: "president" }, 422);
    await hire(world, { bossId: "builder-zzzzzz" }, 422);
    for (let i = 0; i < 7; i++) await hire(world);
    await hire(world, {}, 409);
    expect(await roster(world)).toHaveLength(10);
  });

  it("社員の設定でモデルと上司と勤務の時刻を直せる", async () => {
    await stepUp(world);
    const made = await hire(world);
    const schedule = { start: "10:00", end: "15:00", days: [1, 2, 3, 4, 5] };
    const next = Staff.parse(await api(world, "PATCH", `/api/v1/staff/${made.id}`, { version: 1, role: "直した名前", bossId: "builder", model: "claude-haiku-5-5", schedule }));
    expect(next).toMatchObject({ role: "直した名前", bossId: "builder", model: "claude-haiku-5-5", schedule, version: 2 });
    // 社員の勤務の時刻は全体の勤務の時刻より先に効く。12 月 1 日は火曜日
    expect(await planDay(world.d1.DB, made.id, "2026-12-01")).toMatchObject({ start: at(10), end: at(15) });
    expect(world.gate.audits).toContainEqual(expect.objectContaining({ action: "staff.update", target: made.id }));
  });

  it("モデルを高くする時と勤務を長くする時だけパスキーの確認を求める", async () => {
    await stepUp(world);
    const made = await hire(world);
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = 0").run();
    await api(world, "PATCH", `/api/v1/staff/${made.id}`, { version: 1, model: "claude-opus-5-5" }, 401);
    await api(world, "PATCH", `/api/v1/staff/${made.id}`, { version: 1, schedule: { start: "09:00", end: "18:00", days: [0, 1, 2, 3, 4, 5, 6] } }, 401);
    await api(world, "PATCH", `/api/v1/staff/${made.id}`, { version: 1, model: "claude-haiku-5-5", schedule: { start: "09:00", end: "12:00", days: [1] } });
    // 日をまたぐ勤務は翌日の終わりまでを数えるので、20 時から 19 時は 23 時間で長くなる
    await api(world, "PATCH", `/api/v1/staff/${made.id}`, { version: 2, schedule: { start: "20:00", end: "19:00", days: [1] } }, 401);
    // 短くした勤務から全体の勤務の時刻に戻すのは長くなるので確かめる
    await api(world, "PATCH", `/api/v1/staff/${made.id}`, { version: 2, schedule: null }, 401);
    expect(await rows(world.d1.DB, `SELECT model, version FROM staff WHERE id = '${made.id}'`)).toEqual([{ model: "claude-haiku-5-5", version: 2 }]);
  });

  it("読んだ後に設定が変わっていれば 409 にし、同時の 2 回は片方だけが書ける", async () => {
    const patch = (role: string) =>
      world.gate.request("/api/v1/staff/builder", { method: "PATCH", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, role }) }).then((r) => r.status);
    expect((await Promise.all([patch("A"), patch("B")])).toSorted((a, b) => a - b)).toEqual([200, 409]);
    expect(await rows(world.d1.DB, "SELECT version FROM staff WHERE id = 'builder'")).toEqual([{ version: 2 }]);
    await api(world, "PATCH", "/api/v1/staff/builder", { version: 1, role: "C" }, 409);
  });

  it("自分か自分の部下を上司に選ぶと 422 にする", async () => {
    await api(world, "PATCH", "/api/v1/staff/builder", { version: 1, bossId: "builder" }, 422);
    await api(world, "PATCH", "/api/v1/staff/reviewer", { version: 1, bossId: "builder" });
    await api(world, "PATCH", "/api/v1/staff/builder", { version: 1, bossId: "reviewer" }, 422);
    await api(world, "PATCH", "/api/v1/staff/president", { version: 1, bossId: "builder" }, 422);
    expect(await rows(world.d1.DB, "SELECT id, boss_id FROM staff ORDER BY id")).toEqual([
      { id: "builder", boss_id: "president" },
      { id: "president", boss_id: null },
      { id: "reviewer", boss_id: "builder" },
    ]);
  });

  it("社員を削除すると一覧から消え、残ったタスクが同じ職種の社員に移り、出勤しない", async () => {
    await stepUp(world);
    const made = await hire(world);
    await api(world, "PATCH", "/api/v1/staff/reviewer", { version: 1, bossId: made.id });
    const tasks = [await task(world, made.id), await task(world, made.id)];
    await task(world, "builder");
    await retire(world, `/api/v1/staff/${made.id}`, 204);
    expect(await roster(world)).toEqual(["president", "builder", "reviewer"]);
    // 1 つずつ手の空いた社員を選ぶので、開発担当は 1 人しか居なくても全部が開発担当に移る
    expect(await rows(world.d1.DB, `SELECT assignee FROM nodes WHERE id IN ('${tasks.join("','")}')`)).toEqual([{ assignee: "builder" }, { assignee: "builder" }]);
    expect(await rows(world.d1.DB, "SELECT boss_id FROM staff WHERE id = 'reviewer'")).toEqual([{ boss_id: "president" }]);
    expect(await planDay(world.d1.DB, made.id, "2026-12-01")).toBeNull();
    expect(world.gate.audits).toContainEqual(expect.objectContaining({ action: "staff.retire", target: made.id }));
  });

  it("移すタスクは文ごとに手の空いた社員を選び直す", async () => {
    await stepUp(world);
    const second = await hire(world);
    const third = await hire(world);
    for (let i = 0; i < 4; i++) await task(world, third.id);
    await retire(world, `/api/v1/staff/${third.id}`, 204);
    expect(await rows(world.d1.DB, "SELECT assignee, count(*) AS n FROM nodes WHERE kind = 'task' GROUP BY assignee ORDER BY assignee")).toEqual([
      { assignee: "builder", n: 2 },
      { assignee: second.id, n: 2 },
    ]);
  });

  it("社長と職種の最後の 1 人と作業中の社員は削除できない", async () => {
    await retire(world, "/api/v1/staff/president", 409);
    await retire(world, "/api/v1/staff/reviewer", 409);
    await stepUp(world);
    const made = await hire(world);
    await world.gate.member(made.id).book.wake(at(9));
    await task(world, made.id);
    await world.gate.member(made.id).book.wake(at(9, 1));
    await world.d1.DB.prepare("UPDATE nodes SET status = 'doing' WHERE assignee = ?").bind(made.id).run();
    await retire(world, `/api/v1/staff/${made.id}`, 409);
    expect(await rows(world.d1.DB, `SELECT retired_at FROM staff WHERE id = '${made.id}'`)).toEqual([{ retired_at: null }]);
    await retire(world, "/api/v1/staff/builder-zzzzzz", 404);
  });

  it("同時の削除は 1 回だけ書ける", async () => {
    await stepUp(world);
    const made = await hire(world);
    const statuses = await Promise.all(
      [0, 1].map(async () => (await world.gate.request(`/api/v1/staff/${made.id}`, { method: "DELETE", headers: world.headers })).status),
    );
    // 後の 1 回は、読む前に削除されていれば 404、読んだ後なら印を書けずに 409
    expect(statuses.filter((s) => s === 204)).toHaveLength(1);
    expect(statuses.filter((s) => s === 404 || s === 409)).toHaveLength(1);
    expect(world.gate.audits.filter((a) => a.action === "staff.retire")).toHaveLength(1);
  });

  it("削除の途中で残ったタスクは日次の掃除で移す", async () => {
    await stepUp(world);
    const made = await hire(world);
    const id = await task(world, made.id);
    // 削除の印だけ書いて落ちた事にする
    await world.d1.DB.prepare("UPDATE staff SET retired_at = ? WHERE id = ?").bind(world.clock.now(), made.id).run();
    // 印を書いてすぐは、作業中と分かって印を戻す途中かもしれないので移さない
    expect(await handOverLeftovers(world.d1.DB, world.clock.now() + 9 * MINUTE)).toBe(0);
    expect(await handOverLeftovers(world.d1.DB, world.clock.now() + 10 * MINUTE)).toBe(1);
    expect(await rows(world.d1.DB, `SELECT assignee FROM nodes WHERE id = '${id}'`)).toEqual([{ assignee: "builder" }]);
  });

  it("削除の印を書いた社員はタスクを取れず、印の前に取ったタスクは待ちに戻して移す", async () => {
    await stepUp(world);
    const made = await hire(world);
    const [first, second] = [await task(world, made.id), await task(world, made.id)];
    await world.d1.DB.prepare("UPDATE staff SET retired_at = ? WHERE id = ?").bind(world.clock.now(), made.id).run();
    // 印の後に社員 DO が取りに来ても、担当が在籍でないので取れない
    expect(await claimNode(world.gate.env, await findNode(world.d1.DB, first), world.clock.now())).toBeNull();
    // 印の直前に取って誰も進めていないタスクは、移した先が取れるよう待ちに戻す
    await world.d1.DB.prepare("UPDATE nodes SET status = 'doing' WHERE id = ?").bind(second).run();
    expect(await handOverLeftovers(world.d1.DB, world.clock.now() + 10 * MINUTE)).toBe(2);
    expect(await rows(world.d1.DB, `SELECT status, assignee FROM nodes WHERE id IN ('${first}', '${second}') ORDER BY created_at, id`)).toEqual([
      { status: "todo", assignee: "builder" },
      { status: "todo", assignee: "builder" },
    ]);
  });

  it("削除した社員の作業トークンは使えなくなり、記録は残る", async () => {
    await stepUp(world);
    const made = await hire(world);
    const nodeId = await task(world, made.id);
    const { jti } = await issueTicket(world.gate.env, made.id, nodeId, world.clock.now());
    await retire(world, `/api/v1/staff/${made.id}`, 204);
    expect(await world.gate.member(made.id).guard.checkToken(jti, workspaceIdOf(world.gate.env, made.id), world.clock.now())).toBe("revoked");
    expect(world.gate.audits).toContainEqual(expect.objectContaining({ action: "ticket.revoke", target: jti, detail: { staffId: made.id, reason: "retired" } }));
    expect(await rows(world.d1.DB, `SELECT retired_at IS NOT NULL AS retired FROM staff WHERE id = '${made.id}'`)).toEqual([{ retired: 1 }]);
    expect(await rows(world.d1.DB, `SELECT count(*) AS n FROM staff_prompts WHERE staff_id = '${made.id}'`)).toEqual([{ n: 1 }]);
  });
});
