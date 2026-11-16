// オーナーの情報を扱う拡張 (職務経歴)。項目ごとに暗号にして置き、開くたびにパスキーで確かめて読んだ記録を残し、人に見せる項目だけを書き出す (サービスと拡張の 3.8)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { api, MINUTE, rows, tool, type WorkWorld, useWork } from "../helpers/work.ts";

const world = useWork();

const PROFILE = { summary: "Web の画面を作ってきた", history: "2019 年から A 社で社内の勤怠の仕組みを作った", skills: "TypeScript と React" };

/**
 * パスキーで確かめた事にする。確認の流れそのものは passkey.test.ts で確かめる
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

/**
 * パスキーの確認を切る
 * @param w テストの物
 */
async function stepDown(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = NULL").run();
}

/**
 * 職務経歴の拡張を入れ、経歴を置く
 * @param w テストの物
 */
async function careerWithProfile(w: WorkWorld): Promise<void> {
  await stepUp(w);
  await api(w, "PUT", "/api/v1/extensions/career", { enabled: true });
  expect(await api(w, "PUT", "/api/v1/ext/career/profile", PROFILE)).toEqual(PROFILE);
}

/**
 * R2 の職務経歴の拡張の置き場にある物をつないで読む
 * @param w テストの物
 * @returns 置いた物の中身をつないだ文
 */
async function storedText(w: WorkWorld): Promise<string> {
  const listed = await w.gate.env.FILES.list({ prefix: "ext/career/" });
  const bodies = await Promise.all(listed.objects.map(async (o) => (await w.gate.env.FILES.get(o.key))?.text() ?? ""));
  return bodies.join("\n");
}

describe("オーナーの情報を扱う拡張のセキュリティ", () => {
  it("拡張の情報を開く", async () => {
    await careerWithProfile(world);
    // 項目ごとに暗号にして置き、平文はどこにも残さない
    const sealed = await rows(world.d1.DB, "SELECT field, ciphertext FROM owner_data WHERE ext_id = 'career' ORDER BY field");
    expect(sealed.map((r) => r["field"])).toEqual(["history", "skills", "summary"]);
    for (const r of sealed) for (const value of Object.values(PROFILE)) expect(String(r["ciphertext"])).not.toContain(value);
    expect(await storedText(world)).toBe("");

    // パスキーの確認が切れていると開けない。断った試みは読んだ記録に残さない
    await stepDown(world);
    expect(await api(world, "GET", "/api/v1/ext/career/profile", undefined, 401)).toMatchObject({ code: "step_up_required" });
    expect(await rows(world.d1.DB, "SELECT field FROM owner_data_reads WHERE ext_id = 'career'")).toEqual([]);

    // 確かめた後に開くと中身が出て、項目ごとにオーナーが読んだ記録が残る
    await stepUp(world);
    expect(await api(world, "GET", "/api/v1/ext/career/profile")).toEqual(PROFILE);
    expect(await rows(world.d1.DB, "SELECT by, field, node_id FROM owner_data_reads WHERE ext_id = 'career' ORDER BY field")).toEqual([
      { by: "owner", field: "history", node_id: null },
      { by: "owner", field: "skills", node_id: null },
      { by: "owner", field: "summary", node_id: null },
    ]);
  });

  it("置き直すと項目ごとに 1 行のままで、まだ置いていない項目は空で開く", async () => {
    await stepUp(world);
    await api(world, "PUT", "/api/v1/extensions/career", { enabled: true });
    expect(await api(world, "GET", "/api/v1/ext/career/profile")).toEqual({ summary: "", history: "", skills: "" });
    await api(world, "PUT", "/api/v1/ext/career/profile", PROFILE);
    await api(world, "PUT", "/api/v1/ext/career/profile", { ...PROFILE, skills: "Go" });
    expect(await api(world, "GET", "/api/v1/ext/career/profile")).toEqual({ ...PROFILE, skills: "Go" });
    expect(await rows(world.d1.DB, "SELECT count(*) AS n FROM owner_data WHERE ext_id = 'career'")).toEqual([{ n: 3 }]);
  });

  it("置き換えの途中で 1 項目を書けなければ、どの項目も前の値のまま", async () => {
    await careerWithProfile(world);
    await world.d1.DB.prepare("CREATE TRIGGER career_skills_fails BEFORE INSERT ON owner_data WHEN NEW.field = 'skills' BEGIN SELECT RAISE(ABORT, 'test'); END").run();
    try {
      await api(world, "PUT", "/api/v1/ext/career/profile", { summary: "新しい自己紹介", history: "新しい経歴", skills: "新しいできる事" }, 500);
    } finally {
      await world.d1.DB.prepare("DROP TRIGGER career_skills_fails").run();
    }
    expect(await api(world, "GET", "/api/v1/ext/career/profile")).toEqual(PROFILE);
  });

  it("書く時もパスキーの確認を求め、切った拡張は確かめても 404", async () => {
    await careerWithProfile(world);
    await stepDown(world);
    expect(await api(world, "PUT", "/api/v1/ext/career/profile", { ...PROFILE, summary: "書き換え" }, 401)).toMatchObject({ code: "step_up_required" });
    await api(world, "PUT", "/api/v1/extensions/career", { enabled: false });
    await stepUp(world);
    await api(world, "GET", "/api/v1/ext/career/profile", undefined, 404);
    await api(world, "PUT", "/api/v1/extensions/career", { enabled: true });
    expect(await api(world, "GET", "/api/v1/ext/career/profile")).toEqual(PROFILE);
  });
});

describe("拡張にする物とサービスにする物", () => {
  it("職務経歴を人に見せる", async () => {
    await careerWithProfile(world);
    // 見せる項目だけを書き出す。書き出した物を、見せるサービスの社員がツールで読んでリポジトリに置く
    const Showcase = z.object({ items: z.record(z.string(), z.string()) }).strict();
    expect(Showcase.parse(await api(world, "PUT", "/api/v1/ext/career/showcase", { fields: ["summary", "skills"] }))).toEqual({ items: { summary: PROFILE.summary, skills: PROFILE.skills } });
    expect(world.gate.audits.filter((a) => a.action === "extension.write").map((a) => a.detail)).toContainEqual({ operationId: "updateCareerShowcase" });
    const read = await tool(world, "builder", "ext__career__showcase_read", {});
    expect(JSON.parse(read.content)).toEqual({ items: { summary: PROFILE.summary, skills: PROFILE.skills } });

    // 元の情報 (見せない項目と暗号を解いた物) は know-office の外へ渡す置き場とツールに出ない
    const stored = await storedText(world);
    expect(stored).toContain(PROFILE.skills);
    expect(stored).not.toContain(PROFILE.history);
    expect(read.content).not.toContain(PROFILE.history);
    // 社員が書き出した物を読んでも、オーナーの情報を読んだ事にはならない
    expect(await rows(world.d1.DB, "SELECT by FROM owner_data_reads WHERE by != 'owner'")).toEqual([]);

    // 見せる項目を減らすと、書き出した物も減る
    await api(world, "PUT", "/api/v1/ext/career/showcase", { fields: ["skills"] });
    expect(JSON.parse((await tool(world, "builder", "ext__career__showcase_read", {})).content)).toEqual({ items: { skills: PROFILE.skills } });
    expect(await storedText(world)).not.toContain(PROFILE.summary);
  });

  it("知らない項目と重なった項目は 422 で、書き出した物は変わらない", async () => {
    await careerWithProfile(world);
    await api(world, "PUT", "/api/v1/ext/career/showcase", { fields: ["skills"] });
    await api(world, "PUT", "/api/v1/ext/career/showcase", { fields: ["salary"] }, 422);
    await api(world, "PUT", "/api/v1/ext/career/showcase", { fields: ["skills", "skills"] }, 422);
    expect(JSON.parse((await tool(world, "builder", "ext__career__showcase_read", {})).content)).toEqual({ items: { skills: PROFILE.skills } });
  });
});
