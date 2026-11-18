// GitHub と連携した今を読む。設定の画面のカードは、これで未連携、インストール前、連携済みを分ける (GitHub の連携の 3.1)
import { describe, expect, it } from "vitest";
import { api, useWork } from "../helpers/work.ts";
import { connect, createGitHubApp, returnFromGitHub, stepUp } from "../helpers/github.ts";

const world = useWork();

describe("ボタン 1 つで連携する", () => {
  it("連携の今は、未連携、App を作ってインストールする前、連携済みの順に進む", async () => {
    expect(await api(world, "GET", "/api/v1/github/link")).toEqual({ state: "none" });
    await stepUp(world);
    expect((await returnFromGitHub(world, await createGitHubApp(world))).status).toBe(302);
    expect(await api(world, "GET", "/api/v1/github/link")).toEqual({ state: "app_created" });
  });

  it("インストールまで済むと連携済みにする", async () => {
    await stepUp(world);
    await connect(world);
    expect(await api(world, "GET", "/api/v1/github/link")).toEqual({ state: "installed" });
  });

  it("読むだけなのでパスキーの確認は要らない", async () => {
    expect(await api(world, "GET", "/api/v1/github/link")).toEqual({ state: "none" });
    expect(world.gate.audits.filter((a) => a.action === "step_up.denied")).toEqual([]);
  });
});
