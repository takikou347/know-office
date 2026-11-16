// サービスのリポジトリを、GitHub の触れるリポジトリから選ぶ。試作に進める時と設定で変える時に同じ確かめを通す (サービスと拡張の 3.1、3.3)
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { connect, seedDocsRepo, wrapDb } from "../helpers/github.ts";
import { api, idOf, rows, useWork, type WorkWorld } from "../helpers/work.ts";

const world = useWork({ github: true });

// 試作に進める時は設計書のリポジトリが要るので、選んだ事にする
beforeEach(() => seedDocsRepo(world));

const VIDEO = { title: "動画の切り抜き", kind: "web_app", aim: "長い動画から見どころを切り出す", users: "動画を出す人", costEstimateMicroUsd: 20_000_000, revenueEstimateMicroUsd: 50_000_000 };

/**
 * 検討まで進めた案を作る
 * @param w テストの物
 * @returns サービス ID
 */
async function studied(w: WorkWorld): Promise<string> {
  const id = idOf(await api(w, "POST", "/api/v1/services", VIDEO, 201));
  await api(w, "POST", `/api/v1/services/${id}/advance`, { to: "study", reason: "調べる" });
  return id;
}

const toPrototype = (repo?: string) => ({ to: "prototype", reason: "作る", staffId: "builder", ...(repo === undefined ? {} : { repo }) });

describe("サービスのリポジトリを選ぶ", () => {
  it("試作に進める時に、触れるリポジトリから選ぶ", async () => {
    await connect(world);
    const id = await studied(world);
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype(), 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("example/elsewhere"), 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("../x"), 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("example/know-office"))).toMatchObject({ stage: "prototype", repo: "example/know-office", staffId: "builder" });
    expect(await rows(world.d1.DB, "SELECT repo FROM services WHERE id = ?", id)).toEqual([{ repo: "example/know-office" }]);
  });

  it("試作でない段階にはリポジトリを送れない", async () => {
    await connect(world);
    const id = idOf(await api(world, "POST", "/api/v1/services", VIDEO, 201));
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, { to: "study", reason: "調べる", repo: "example/know-office" }, 422)).toMatchObject({ code: "validation_failed" });
  });

  it("GitHub とつなぐまでは選べず 409", async () => {
    const id = await studied(world);
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("example/know-office"), 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT stage FROM services WHERE id = ?", id)).toEqual([{ stage: "study" }]);
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: "example/know-office", reason: "選ぶ" }, 409)).toMatchObject({ code: "conflict" });
  });

  it("GitHub が失敗したら 502 で、段階は変わらない", async () => {
    await connect(world);
    const id = await studied(world);
    world.gate.github.failNext("GET /installation/repositories", 500);
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("example/know-office"), 502)).toMatchObject({ code: "upstream_failed" });
    expect(await rows(world.d1.DB, "SELECT stage, repo FROM services WHERE id = ?", id)).toEqual([{ stage: "study", repo: null }]);
  });

  it("GitHub の上限に当たったら、待つ秒を付けて 429 で返し、段階は変わらない", async () => {
    await connect(world);
    const id = await studied(world);
    world.gate.github.failNext("GET /installation/repositories", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456120", date: "Tue, 01 Jan 2030 00:00:00 GMT" });
    const res = await world.gate.request(`/api/v1/services/${id}/advance`, {
      method: "POST",
      headers: { ...world.headers, "Content-Type": "application/json" },
      body: JSON.stringify(toPrototype("example/know-office")),
    });
    expect({ status: res.status, retryAfter: res.headers.get("retry-after"), code: z.object({ code: z.string() }).loose().parse(await res.json()).code }).toEqual({
      status: 429,
      retryAfter: "120",
      code: "rate_limited",
    });
    expect(await rows(world.d1.DB, "SELECT stage, repo FROM services WHERE id = ?", id)).toEqual([{ stage: "study", repo: null }]);
  });

  it("確かめた後に連携が変わったら 409 で、何も書かない", async () => {
    await connect(world);
    const id = await studied(world);
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        restore();
        await world.d1.DB.prepare("UPDATE vault SET revoked_at = 1 WHERE name = 'github_installation'").run();
        return real(statements);
      },
    });
    expect(await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("example/know-office"), 409)).toMatchObject({ code: "conflict" });
    expect(await rows(world.d1.DB, "SELECT stage, repo FROM services WHERE id = ?", id)).toEqual([{ stage: "study", repo: null }]);
    expect(await rows(world.d1.DB, "SELECT id FROM service_events WHERE service_id = ? AND json_extract(detail, '$.to') = 'prototype'", id)).toEqual([]);
  });

  it("設定でリポジトリを変えると、サービスの行も変わる", async () => {
    await connect(world);
    const id = await studied(world);
    await api(world, "POST", `/api/v1/services/${id}/advance`, toPrototype("example/know-office"));
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: "example/elsewhere", reason: "移す" }, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: null, reason: "戻す" }, 422)).toMatchObject({ code: "validation_failed" });
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: "example/knowidea-ui", reason: "移す" })).toEqual({ key: "repo", value: "example/knowidea-ui", inherited: false, version: 1 });
    expect(await rows(world.d1.DB, "SELECT repo FROM services WHERE id = ?", id)).toEqual([{ repo: "example/knowidea-ui" }]);
    expect(await api(world, "PUT", `/api/v1/services/${id}/settings/repo`, { version: 0, value: "example/know-office", reason: "古い版" }, 409)).toMatchObject({ code: "conflict" });
  });
});
