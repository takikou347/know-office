// ルールセットを掛け直すだけの操作。今の設定のまま公開のリポジトリにルールセットを掛け、同じ名前のルールセットを 2 つ作らない (GitHub の連携の 3.3)
import { newId } from "@know-office/core";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { services } from "../../src/gate/db/main.ts";
import { api, MINUTE, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

// マイグレーションで登録した最初の 2 つのサービスは、代わりの GitHub に無いリポジトリを指すので、テストごとに置くサービスだけにする
beforeEach(async () => {
  await drizzle(world.d1.DB).delete(services);
});

const UI = "example/knowidea-ui";
const OFFICE = "example/know-office";

/**
 * サービスを 1 つ置く
 * @param w テストの物
 * @param repo リポジトリ
 */
async function service(w: WorkWorld, repo: string): Promise<void> {
  await drizzle(w.d1.DB).insert(services).values({ id: newId(w.clock), name: repo.split("/")[1] ?? repo, kind: "library", stage: "operation", repo, staffId: "builder", createdAt: w.clock.now() });
}

/**
 * 代わりの GitHub にリポジトリを置く。ルールセットはまだ無い
 * @param w テストの物
 * @param repo リポジトリ
 * @param options 非公開か
 * @param options.private 非公開なら true
 */
function repoOnGitHub(w: WorkWorld, repo: string, options: { private: boolean }): void {
  const gh = w.gate.github;
  gh.set(`GET /repos/${repo}`, { full_name: repo, private: options.private, default_branch: "main" });
  gh.set(`GET /repos/${repo}/rulesets`, []);
  gh.set(`POST /repos/${repo}/rulesets`, { id: 7, name: "know-office" });
  gh.set(`GET /repos/${repo}/commits/main/check-runs`, { total_count: 1, check_runs: [{ name: "verify", status: "completed", conclusion: "success" }] });
}

/**
 * GitHub に送った書き込みの道を並べる
 * @param w テストの物
 * @returns 「メソッド 道」の並び
 */
function writes(w: WorkWorld): string[] {
  return w.gate.github.requests.map((r) => r.route).filter((r) => !r.startsWith("GET "));
}

/**
 * パスキーで確かめた事にする
 * @param w テストの物
 */
async function stepUp(w: WorkWorld): Promise<void> {
  await w.d1.DB.prepare("UPDATE sessions SET step_up_until = ?").bind(w.clock.now() + 15 * MINUTE).run();
}

describe("ルールセットを掛け直す", () => {
  it("今の設定のまま公開のリポジトリにルールセットを掛け直し、掛けたリポジトリを返す", async () => {
    await service(world, UI);
    await service(world, OFFICE);
    repoOnGitHub(world, UI, { private: false });
    repoOnGitHub(world, OFFICE, { private: true });
    await stepUp(world);
    expect(await api(world, "POST", "/api/v1/github/rules/apply")).toEqual({ applied: [UI] });
    expect(writes(world)).toEqual([`POST /repos/${UI}/rulesets`]);
    // 設定は変えず、掛け直した事だけを残す
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM settings")).toEqual([{ n: 0 }]);
    expect(world.gate.audits.filter((a) => a.action === "github.rules_apply")).toEqual([expect.objectContaining({ target: "github.rules", detail: { repos: null, version: 0 } })]);
  });

  it("GitHub が失敗したら 502 で、もう 1 度押すとルールセットは 1 つだけになる", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    await stepUp(world);
    world.gate.github.set(`POST /repos/${UI}/rulesets`, undefined);
    await api(world, "POST", "/api/v1/github/rules/apply", undefined, 502);
    // 失敗も掛け直そうとした事として残す
    // GitHub を呼ぶ前に残すので、失敗しても掛け直そうとした事は残る
    expect(world.gate.audits.filter((a) => a.action === "github.rules_apply").map((a) => a.detail)).toEqual([{ repos: null, version: 0 }]);
    // 1 度目で作れていた時は、2 度目は同じ名前のルールセットを置き換える
    world.gate.github.set(`GET /repos/${UI}/rulesets`, [{ id: 42, name: "know-office" }]);
    world.gate.github.set(`PUT /repos/${UI}/rulesets/42`, { id: 42, name: "know-office" });
    expect(await api(world, "POST", "/api/v1/github/rules/apply")).toEqual({ applied: [UI] });
    expect(writes(world).filter((r) => r.startsWith(`POST /repos/${UI}/rulesets`))).toHaveLength(1);
    expect(writes(world).at(-1)).toBe(`PUT /repos/${UI}/rulesets/42`);
  });

  it("2 つ目で失敗すると 502 で、1 つ目は掛かったまま、押し直すと 1 つ目を置き換えて 2 つ目を掛ける", async () => {
    const other = "example/knowidea-docs";
    await service(world, UI);
    await service(world, other);
    repoOnGitHub(world, UI, { private: false });
    repoOnGitHub(world, other, { private: false });
    await stepUp(world);
    world.gate.github.set(`POST /repos/${other}/rulesets`, undefined);
    await api(world, "POST", "/api/v1/github/rules/apply", undefined, 502);
    expect(writes(world)).toEqual([`POST /repos/${UI}/rulesets`, `POST /repos/${other}/rulesets`]);
    expect(world.gate.audits.filter((a) => a.action === "github.rules_apply")).toHaveLength(1);

    // 1 つ目は GitHub の側に残っているので、押し直すと作り足さずに置き換える
    world.gate.github.set(`GET /repos/${UI}/rulesets`, [{ id: 7, name: "know-office" }]);
    world.gate.github.set(`PUT /repos/${UI}/rulesets/7`, { id: 7, name: "know-office" });
    world.gate.github.set(`POST /repos/${other}/rulesets`, { id: 8, name: "know-office" });
    expect(await api(world, "POST", "/api/v1/github/rules/apply")).toEqual({ applied: [UI, other] });
    expect(writes(world).slice(2)).toEqual([`PUT /repos/${UI}/rulesets/7`, `POST /repos/${other}/rulesets`]);
  });

  it("同時に 2 度押すと、片方は 409 で、ルールセットは 1 つだけ作る", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    await stepUp(world);
    const press = () => world.gate.request("/api/v1/github/rules/apply", { method: "POST", headers: world.headers });
    const statuses = (await Promise.all([press(), press()])).map((r) => r.status).toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    expect(writes(world)).toEqual([`POST /repos/${UI}/rulesets`]);
    // 錠は外れているので、次に押せば通る
    world.gate.github.set(`GET /repos/${UI}/rulesets`, [{ id: 7, name: "know-office" }]);
    world.gate.github.set(`PUT /repos/${UI}/rulesets/7`, { id: 7, name: "know-office" });
    expect(await api(world, "POST", "/api/v1/github/rules/apply")).toEqual({ applied: [UI] });
  });

  it("外されなかった錠は 5 分ちょうどの手前まで 409 で、5 分で取り直せる", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    // 前の掛け直しが錠を取ったまま落ちた
    await world.d1.DB.prepare("INSERT INTO locks (name, holder, until) VALUES ('github.rules_apply', 'gone', ?)").bind(world.clock.now() + 5 * MINUTE).run();
    world.clock.advance(5 * MINUTE - 1);
    await stepUp(world);
    expect(await api(world, "POST", "/api/v1/github/rules/apply", undefined, 409)).toMatchObject({ code: "conflict" });
    expect(writes(world)).toEqual([]);
    world.clock.advance(1);
    expect(await api(world, "POST", "/api/v1/github/rules/apply")).toEqual({ applied: [UI] });
  });

  it("監査ログに書けなければ GitHub を呼ばずに 500 にし、錠を外す", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    await stepUp(world);
    const real = world.gate.env.RECORDER;
    // 記録 DO の代わりは append だけを持つ
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    world.gate.env.RECORDER = { idFromName: () => "recorder", get: () => ({ append: () => Promise.reject(new Error("記録 DO に届かない")) }) } as unknown as typeof real;
    try {
      expect(await api(world, "POST", "/api/v1/github/rules/apply", undefined, 500)).toMatchObject({ code: "internal" });
    } finally {
      world.gate.env.RECORDER = real;
    }
    expect(writes(world)).toEqual([]);
    expect(await rows(world.d1.DB, "SELECT name FROM locks")).toEqual([]);
  });

  it("パスキーの確認が無ければ 401 で、GitHub を呼ばない", async () => {
    await service(world, UI);
    repoOnGitHub(world, UI, { private: false });
    expect(await api(world, "POST", "/api/v1/github/rules/apply", undefined, 401)).toMatchObject({ code: "step_up_required" });
    expect(writes(world)).toEqual([]);
  });
});
