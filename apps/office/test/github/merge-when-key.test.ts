// 全部のテストを 1 つの worker で読み回すと、先に読んだファイルしだいで import の輪が値の無い名前を残す。サービスの設定を先に読んでも、main に入れる条件の設定のキーが決まる事を確かめる
// 先に読む順をこのファイルで作るため、サービスの設定を頭で読む
import { DEFAULT_PREFIX } from "../../src/gate/services/settings.ts";
import { MERGE_WHEN_KEY } from "../../src/gate/github/rules.ts";
import { describe, expect, it } from "vitest";

describe("main に入れる条件の設定のキー", () => {
  it("サービスの設定を先に読んでも、office の初期値のキーになる", () => {
    expect([DEFAULT_PREFIX, MERGE_WHEN_KEY]).toEqual(["service.", "service.mergeWhen"]);
  });
});
