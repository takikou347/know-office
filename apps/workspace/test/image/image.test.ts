// 作ったワークスペースのイメージで、社員がフックと実行物を書き換えられず、サーバーの鍵とメモリと 8080 番に触れない事を Docker で確かめる (社員が考えるの 3.2、テスト設計の社員が考える)
// Docker が要るので pnpm test では流さず、イメージを作った後に pnpm --filter @know-office/workspace test:image で流す。CI は check.yml の image で流す
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** 確かめるイメージ。WORKSPACE_IMAGE で替える */
const IMAGE = process.env.WORKSPACE_IMAGE ?? "know-office-workspace:test";
/** サーバーに渡す鍵。社員から読めない事を確かめる */
const KEY = "k".repeat(43);

/**
 * 動いているコンテナの中で、社員の利用者 (staff) か root で sh の命令を走らせる
 * @param id コンテナ
 * @param script 命令
 * @param user 利用者
 * @returns 終わりのコードと出力
 */
function inServer(id: string, script: string, user = "staff"): { code: number; out: string } {
  const run = spawnSync("docker", ["exec", "-u", user, id, "sh", "-c", script], { encoding: "utf8", timeout: 30_000 });
  return { code: run.status ?? 1, out: `${run.stdout}${run.stderr}`.trim() };
}

/**
 * イメージの中で sh の命令を社員の利用者で走らせる
 * @param script 命令
 * @returns 終わりのコードと出力
 */
function inImage(script: string): { code: number; out: string } {
  const run = spawnSync("docker", ["run", "--rm", "--network", "none", "--user", "staff", "--entrypoint", "sh", IMAGE, "-c", script], { encoding: "utf8", timeout: 30_000 });
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
    id = execFileSync("docker", ["run", "-d", "--rm", "--network", "none", "-e", `WORKSPACE_KEY=${KEY}`, IMAGE], { encoding: "utf8" }).trim();
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

  it("サーバーは root で、社員の子のプロセスは staff で動く", () => {
    expect(inServer(id, "stat -c %u /proc/1", "root")).toEqual({ code: 0, out: "0" });
    // サーバーと同じ staffSpawner で子を起こし、利用者と組を見る
    const script = [
      "import('/opt/workspace/apps/workspace/src/spawn.ts').then(({ staffSpawner }) => {",
      "  const child = staffSpawner()({ command: 'sh', args: ['-c', 'id -u; id -g; id -G'], env: { PATH: process.env.PATH }, signal: new AbortController().signal });",
      "  child.stdout.pipe(process.stdout);",
      "});",
    ].join("\n");
    const run = spawnSync("docker", ["exec", id, "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
    expect(run.stdout.trim()).toBe("10001\n10001\n10001");
  });

  it("社員はサーバーの /proc/<pid>/environ を読めない", () => {
    const read = inServer(id, "cat /proc/1/environ");
    expect(read.code).not.toBe(0);
    expect(read.out).not.toContain(KEY);
  });

  it("社員はサーバーのメモリを読めない", () => {
    for (const script of ["head -c 1 /proc/1/mem", "cat /proc/1/maps", "ls /proc/1/fd"]) {
      expect({ script, code: inServer(id, script).code }).not.toEqual({ script, code: 0 });
    }
  });

  it("社員はサーバーに合図を送れず、止められない", () => {
    // 対照: root は同じ pid に合図を送れる。社員が断られるのは uid が違うから
    expect(inServer(id, "kill -0 1", "root").code).toBe(0);
    for (const signal of ["-0", "-TERM", "-KILL"]) {
      const sent = inServer(id, `kill ${signal} 1`);
      expect({ signal, code: sent.code === 0, out: /not permitted/i.test(sent.out) }).toEqual({ signal, code: false, out: true });
    }
    expect(inServer(id, "stat -c %u /proc/1", "root")).toEqual({ code: 0, out: "0" });
  });

  it("社員は 8080 番を取れない", () => {
    // サーバーを止められないので、8080 番は使われたまま。Docker は 1024 未満の番号を誰にでも許す (ip_unprivileged_port_start=0) ので、番号の小ささでは確かめない
    const listen = inServer(id, `node -e "require('net').createServer().on('error',(e)=>{console.log(e.code);process.exit(1)}).listen(8080,'0.0.0.0',()=>process.exit(0))"`);
    expect(listen).toEqual({ code: 1, out: "EADDRINUSE" });
    // 8080 番で答えているのは、root のサーバーのまま
    expect(inServer(id, "stat -c %u /proc/1", "root")).toEqual({ code: 0, out: "0" });
    expect(inServer(id, `node -e "fetch('http://127.0.0.1:8080/v1/health').then(r=>r.text()).then(console.log)"`).out).toContain('"part":"workspace"');
  });
});
