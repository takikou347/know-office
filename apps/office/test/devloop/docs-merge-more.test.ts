// 設計書を同じ時に直す、2 つの PR を入れる所の細かい守り。負けた側は要件のハッシュを書かず、分かれた時は失敗の種類を残し、設計書の側の答えは断る、落ちた、待つの順に出す (開発の回し方の 3.6)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@know-office/core";
import { DOCS, REPO, synchronize } from "../helpers/docs.ts";
import { CODE_HEAD, DOCS_HEAD, DOCS_NEXT } from "../helpers/docs-together.ts";
import { approve, reqHash, retry, reviewed, statusOf } from "../helpers/docs-land.ts";
import { BASE, detail } from "../helpers/issues.ts";
import { eventsOf } from "../helpers/review.ts";
import { rows, useWork } from "../helpers/work.ts";
import { findNode } from "../../src/gate/work/nodes.ts";
import { mergeMade } from "../../src/gate/work/merge-made.ts";

const world = useWork({ github: true });

/**
 * 設計書の PR が子の要件の本文を変えた状態にする。要件のハッシュが変わる
 * @param repos 代わりの GitHub の記録
 * @param repos.files 設計書のファイル
 */
function changeRequirement(repos: { files: Record<string, string> }): void {
  repos.files[`${BASE}/1-video.md`] = detail({ first: "文章と画像から作る" });
}

/**
 * レビュー担当が承認した事にする (承認の呼びの代わり)
 * @param task タスク ID
 */
async function approved(task: string): Promise<void> {
  await world.d1.DB.prepare("UPDATE reviews SET reviewer_verdict = 'approve' WHERE node_id = ?").bind(task).run();
}

/**
 * タスクの出来事から、種類の出来事の中身を読む
 * @param task タスク ID
 * @param kind 種類
 * @returns 中身。無ければ undefined
 */
async function detailOf(task: string, kind: string): Promise<Record<string, unknown> | undefined> {
  return (await eventsOf(world, task)).find((e) => e.kind === kind)?.detail;
}

describe("設計書を同じ時に直す", () => {
  it("確かめたタスクが変わって負けた側は、要件のハッシュを書かない", async () => {
    const { task, repos } = await reviewed(world);
    changeRequirement(repos);
    const before = await reqHash(world);
    await approved(task);
    // 読んだ後にタスクの版が進んだ (done にする文が負ける)
    await expect(retry(world, task, true)).rejects.toMatchObject({ code: "conflict" });
    expect(await reqHash(world)).toBe(before);
    expect(repos.merges).toEqual([]);
  });

  it("入れられず戻した時は、要件のハッシュも元に戻す", async () => {
    const { task, repos } = await reviewed(world);
    changeRequirement(repos);
    const before = await reqHash(world);
    // main が先に進んでいて何も進めない
    repos.stale.add(REPO);
    expect(await approve(world)).toBe(false);
    expect(await reqHash(world)).toBe(before);
    // 設計書の main を進める更新が GitHub の失敗で断られる
    repos.stale.delete(REPO);
    repos.broken.add(DOCS);
    await expect(retry(world, task)).rejects.toThrow("GitHub が main を進める更新を断った");
    expect(await reqHash(world)).toBe(before);
    expect(await statusOf(world, task)).toBe("review");
  });

  it("設計書がもう main に入っていても、コードを入れる時に要件のハッシュを合わせる", async () => {
    const { repos } = await reviewed(world);
    changeRequirement(repos);
    const before = await reqHash(world);
    // 設計書の PR は別の道で先に入った
    repos.landed.add(`${DOCS}:${DOCS_HEAD}`);
    expect(await approve(world)).toBe(true);
    expect(repos.merges).toEqual([`${REPO}:${CODE_HEAD}`]);
    expect(await reqHash(world)).not.toBe(before);
  });

  it("コードが入らず分かれた時は、失敗の種類を出来事とエラーログに残す", async () => {
    const { task, repos } = await reviewed(world);
    repos.broken.add(REPO);
    expect(await approve(world)).toBe(false);
    expect(await detailOf(task, "devloop_split")).toMatchObject({ to: "review", code: "internal" });
    expect(await rows(world.d1.REC_2026, "SELECT level, code FROM error_events WHERE code = 'devloop_split'")).toEqual([{ level: "warn", code: "devloop_split" }]);
  });

  it("コードの main の更新が GitHub に断られて分かれた時は、その種類を残す", async () => {
    const { task } = await reviewed(world);
    const real = world.forge.merge.bind(world.forge);
    world.forge.merge = (repo, head) => (repo === REPO ? Promise.reject(new AppError("upstream_failed", "GitHub が main を進める更新を断った")) : real(repo, head));
    expect(await approve(world)).toBe(false);
    expect(await detailOf(task, "devloop_split")).toMatchObject({ to: "review", code: "upstream_failed" });
  });

  it("コードが main に遅れて分かれた時は、遅れた事を種類にして todo に戻す", async () => {
    const { task, repos } = await reviewed(world);
    repos.behind.add(REPO);
    expect(await approve(world)).toBe(false);
    expect(await detailOf(task, "devloop_split")).toMatchObject({ to: "todo", code: "behind" });
  });

  it.each([
    ["設計書", DOCS],
    ["コード", REPO],
  ])("%s の側が遅れて何も進めなかった時は、遅れたリポジトリを出来事に残す", async (_name, repo) => {
    const { task, repos } = await reviewed(world);
    if (repo === DOCS) repos.behind.add(DOCS);
    else repos.stale.add(REPO);
    expect(await approve(world)).toBe(false);
    expect(await detailOf(task, "main_advanced")).toMatchObject({ repo });
  });

  it("分かれた時は、通知を配る", async () => {
    const { repos } = await reviewed(world);
    repos.broken.add(REPO);
    await approve(world);
    const [notice] = await rows(world.d1.DB, "SELECT id FROM notices WHERE kind = 'devloop_split'");
    expect(world.gate.live.published).toContainEqual({ type: "notice", notice: { id: z.string().parse(notice?.["id"]) } });
  });

  it("レビューの行が無い子 Issue のタスクは、done にする前に見つからないで断る", async () => {
    const { task } = await reviewed(world);
    await world.d1.DB.prepare("DELETE FROM reviews WHERE node_id = ?").bind(task).run();
    const made = await findNode(world.gate.env.DB, task);
    await expect(mergeMade(world.gate.env, world.forge, made, { repo: REPO, branch: "ko/x-make", sha: CODE_HEAD }, world.clock.now())).rejects.toMatchObject({ code: "not_found" });
    expect(await statusOf(world, task)).toBe(made.status);
  });

  it("設計書の側は、断る、落ちた、待つの順に答える", async () => {
    const { task, repos } = await reviewed(world);
    // 最初の設計書でオーナーの承認を待っていても、チェックが落ちていれば落ちた
    const read = world.forge.readFile.bind(world.forge);
    world.forge.readFile = (repo, ref, path) => (path.endsWith("/README.md") && ref !== DOCS_HEAD ? Promise.resolve(null) : read(repo, ref, path));
    repos.checks[DOCS] = "failed";
    expect(await approve(world)).toBe(false);
    expect(await detailOf(task, "merge_refused")).toMatchObject({ reason: "docs_checks" });
    expect(await detailOf(task, "merge_waiting")).toBeUndefined();
    // チェックが通れば、オーナーの承認を待つ
    repos.checks[DOCS] = "passed";
    expect(await retry(world, task)).toBe(false);
    expect(await detailOf(task, "merge_waiting")).toMatchObject({ reason: "owner" });
    expect(repos.merges).toEqual([]);
  });

  it("ブランチの先が進んでも、確かめた先で入れる", async () => {
    const { task, repos } = await reviewed(world);
    repos.heads.set(`${DOCS}:ko/${task.slice(0, 8)}-spec`, DOCS_NEXT);
    expect(await approve(world)).toBe(true);
    expect(repos.merges).toEqual([`${DOCS}:${DOCS_HEAD}`, `${REPO}:${CODE_HEAD}`]);
  });

  it("確かめた先と違う先は入れない", async () => {
    const { task, repos } = await reviewed(world);
    await synchronize(world, DOCS, DOCS_NEXT, 11);
    expect(await retry(world, task)).toBe(false);
    expect(repos.merges).toEqual([]);
    expect(await statusOf(world, task)).toBe("review");
  });
});
