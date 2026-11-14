// 作ったワークスペースのイメージで、社員がフックと実行物を書き換えられない事を Docker で確かめる (社員が考えるの 3.1、4 章)
// Docker が要るので pnpm test では流さず、イメージを作った後に pnpm --filter @know-office/workspace test:image で流す
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** 確かめるイメージ。WORKSPACE_IMAGE で替える */
const IMAGE = process.env.WORKSPACE_IMAGE ?? "know-office-workspace:test";

/**
 * イメージの中で sh の命令を社員の利用者で走らせる
 * @param script 命令
 * @returns 終わりのコードと出力
 */
function inImage(script: string): { code: number; out: string } {
  const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sh", IMAGE, "-c", script], { encoding: "utf8", timeout: 30_000 });
  return { code: run.status ?? 1, out: `${run.stdout}${run.stderr}`.trim() };
}

describe("フックを書き換えられない", () => {
  it("社員は root でない staff の利用者で動く", () => {
    expect(inImage("id -un; id -u; id -Gn")).toEqual({ code: 0, out: "staff\n10001\noffice" });
  });

  it("/opt/workspace のフックと実行物に書けない", () => {
    for (const script of [
      "touch /opt/workspace/x",
      "echo x >> /opt/workspace/apps/workspace/src/hooks.ts",
      "echo x >> /opt/workspace/packages/core/src/index.ts",
      "rm -f /opt/workspace/apps/workspace/src/hooks.ts",
      "mkdir /opt/workspace/apps/workspace/.claude",
      "touch /usr/local/bin/node",
    ]) {
      expect({ script, code: inImage(script).code }).not.toEqual({ script, code: 0 });
    }
  });

  it("/work には書ける", () => {
    expect(inImage("touch /work/a && echo ok").out).toBe("ok");
  });
});

describe("ワークスペースのサーバー", () => {
  let id = "";

  beforeAll(() => {
    id = execFileSync("docker", ["run", "-d", "--rm", "--network", "none", IMAGE], { encoding: "utf8" }).trim();
  });

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", id]);
  });

  it("/v1/health がワークスペースの様子を返す", async () => {
    let out = "";
    for (let n = 0; n < 20 && !out.includes('"part":"workspace"'); n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      out = spawnSync("docker", ["exec", id, "node", "-e", "fetch('http://127.0.0.1:8080/v1/health').then(r=>r.text()).then(console.log)"], { encoding: "utf8" }).stdout;
    }
    expect(out).toContain('"part":"workspace"');
  }, 15_000);
});
