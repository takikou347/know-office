// 作ったワークスペースのイメージで、補完の tsc が利用者 lsp で動き、社員と tsc が互いの物に触れない事を Docker で確かめる (社員が考えるの 2 章、仕事とレビューの 3.6)
// Docker が要るので pnpm test では流さず、イメージを作った後に pnpm --filter @know-office/workspace test:image で流す
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tarGz } from "../helpers/tar.ts";

/** 確かめるイメージ。WORKSPACE_IMAGE で替える */
const IMAGE = process.env.WORKSPACE_IMAGE ?? "know-office-workspace:test";
/** サーバーに渡す鍵 */
const KEY = "k".repeat(43);
const NODE = "0190f4a8-0000-7000-8000-000000000101";
const SHA = "a".repeat(40);
/** 社員の作業に置いた、tsc に読ませない値 */
const SECRET = "work-secret-value";

/** 木の外 (/work) を指す tsconfig を持つレビューの木 */
const TREE = tarGz([
  { name: "top/", type: "dir" },
  {
    name: "top/tsconfig.json",
    body: JSON.stringify({ extends: "/work/secret/tsconfig.json", compilerOptions: { strict: true, noEmit: true, typeRoots: ["/work/secret/types"] }, include: ["src", "/work/secret/*.ts"] }),
  },
  { name: "top/src/a.ts", body: "export const a: number = leaked;\n" },
]);

/**
 * 画面の代わりに補完の口を使う、コンテナの中で走らせるスクリプト。木を渡してつなぎ、診断と型を求め、受けた物を /tmp/lsp-out.json に書く
 * ws は /opt/workspace/apps/workspace の依存から読む
 */
const CLIENT = `
import { writeFileSync } from "node:fs";
import { WebSocket } from "ws";
const auth = { authorization: "Bearer ${KEY}" };
const put = await fetch("http://127.0.0.1:8080/v1/lsp/trees/${NODE}/${SHA}", { method: "PUT", headers: auth, body: Buffer.from("${TREE.toString("base64")}", "base64") });
if (put.status !== 204) { console.log("put", put.status); process.exit(1); }
const ws = new WebSocket("ws://127.0.0.1:8080/v1/lsp?nodeId=${NODE}&sha=${SHA}", { headers: auth });
const got = [];
ws.on("message", (data) => got.push(JSON.parse(String(data))));
await new Promise((resolve) => ws.once("open", resolve));
const send = (message) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
const wait = async (id) => { for (let n = 0; n < 400; n += 1) { const found = got.find((m) => m.id === id); if (found) return found; await new Promise((r) => setTimeout(r, 25)); } };
const uri = "file:///repo/src/a.ts";
send({ id: 1, method: "initialize", params: {} });
await wait(1);
send({ method: "initialized", params: {} });
send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: "export const a: number = leaked;\\n" } } });
send({ id: 2, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
await wait(2);
send({ id: 3, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 0, character: 27 } } });
await wait(3);
writeFileSync("/tmp/lsp-out.json", JSON.stringify(got));
// tsc を見るテストのために接続を開いたままにする
setTimeout(() => process.exit(0), 120_000);
`;

/**
 * 動いているコンテナの中で sh の命令を走らせる
 * @param id コンテナ
 * @param script 命令
 * @param user 利用者
 * @returns 終わりのコードと出力
 */
function inServer(id: string, script: string, user = "staff"): { code: number; out: string } {
  const run = spawnSync("docker", ["exec", "-u", user, id, "sh", "-c", script], { encoding: "utf8", timeout: 30_000 });
  return { code: run.status ?? 1, out: `${run.stdout}${run.stderr}`.trim() };
}

describe("エディタの補完のイメージ", () => {
  let id = "";
  let tscPid = "";
  let received = "";

  beforeAll(() => {
    id = execFileSync("docker", ["run", "-d", "--rm", "--network", "none", "-e", `WORKSPACE_KEY=${KEY}`, IMAGE], { encoding: "utf8" }).trim();
    // 社員の作業に、tsconfig が指す物と値を置く
    const setup = [
      "mkdir -p /work/secret/types/leak",
      `echo '{"compilerOptions":{"strict":true}}' > /work/secret/tsconfig.json`,
      `echo 'export const secret = "${SECRET}";' > /work/secret/secret.ts`,
      `echo 'declare const leaked: "${SECRET}";' > /work/secret/types/leak/index.d.ts`,
    ].join(" && ");
    if (inServer(id, setup).code !== 0) throw new Error("社員の作業を置けない");
    for (let n = 0; n < 40; n += 1) {
      if (inServer(id, `node -e "fetch('http://127.0.0.1:8080/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`, "root").code === 0) break;
      spawnSync("sleep", ["0.25"]);
    }
    execFileSync("docker", ["exec", "-d", "-w", "/opt/workspace/apps/workspace", id, "node", "--input-type=module", "-e", CLIENT]);
    for (let n = 0; n < 160 && received === ""; n += 1) {
      spawnSync("sleep", ["0.25"]);
      received = inServer(id, "cat /tmp/lsp-out.json 2>/dev/null", "root").out;
    }
    // Go の tsc は Node の入口から同じ番号のまま execve するので、名前が tsc のプロセスを探す。/proc/<pid>/exe は CAP_SYS_PTRACE の無い root にも読めない
    tscPid = inServer(id, String.raw`grep -l '^Name:\stsc$' /proc/[0-9]*/status | head -1 | cut -d/ -f3`, "root").out;
  }, 60_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", id]);
  });

  it("イメージに lsp の利用者があり、/review が root の 0755、/work が staff の 0700", () => {
    expect(inServer(id, "id -u lsp; id -g lsp; id -Gn lsp", "root")).toEqual({ code: 0, out: "10002\n10002\nlsp" });
    expect(inServer(id, "stat -c '%u %g %a' /review /work /home/staff", "root")).toEqual({ code: 0, out: "0 0 755\n10001 10001 700\n10001 10001 700" });
  });

  it("staff の子のプロセスから /review に書けない", () => {
    expect(inServer(id, `test -f /review/${NODE}/${SHA}/src/a.ts && echo ok`, "root").out).toBe("ok");
    for (const script of ["touch /review/x", `touch /review/${NODE}/x`, `echo x >> /review/${NODE}/${SHA}/src/a.ts`, `rm -rf /review/${NODE}/${SHA}/src`, `mkdir /review/${NODE}/${SHA}/y`]) {
      expect({ script, code: inServer(id, script).code }).not.toEqual({ script, code: 0 });
    }
    // lsp も書けず、読むだけ
    expect(inServer(id, `cat /review/${NODE}/${SHA}/src/a.ts`, "lsp")).toEqual({ code: 0, out: "export const a: number = leaked;" });
    expect(inServer(id, `touch /review/${NODE}/${SHA}/x`, "lsp").code).not.toBe(0);
  });

  it("tsc は lsp の利用者で、nice 10 で動き、サーバーが RSS を読める", () => {
    expect(tscPid).toMatch(/^\d+$/);
    // /proc/<pid>/stat の 19 番目が nice。GOMEMLIMIT は environ を root も読めないので、起こす引数の単体のテストで確かめる
    expect(inServer(id, `stat -c %u /proc/${tscPid}; cut -d' ' -f19 /proc/${tscPid}/stat`, "root")).toEqual({ code: 0, out: "10002\n10" });
    // 見張りと同じ procRss で、root のサーバーが lsp の tsc の RSS を読める
    const script = `import('/opt/workspace/apps/workspace/src/lsp-tsc.ts').then(({ procRss }) => console.log(procRss(${tscPid}) > 0))`;
    const run = spawnSync("docker", ["exec", id, "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
    expect(run.stdout.trim()).toBe("true");
  });

  it("staff の子のプロセスから tsc の /proc/<pid> を読めない", () => {
    for (const script of [`cat /proc/${tscPid}/environ`, `head -c 1 /proc/${tscPid}/mem`, `ls /proc/${tscPid}/fd`, `kill -0 ${tscPid}`]) {
      expect({ script, code: inServer(id, script).code }).not.toEqual({ script, code: 0 });
    }
  });

  it("lsp の tsc から /work を読めない", () => {
    for (const script of ["ls /work", "cat /work/secret/secret.ts", "ls /home/staff", "cat /proc/1/environ"]) {
      expect({ script, code: inServer(id, script, "lsp").code }).not.toEqual({ script, code: 0 });
    }
    // tsconfig が /work を指しても、tsc は読めず、画面に中身も道も返らない
    expect(received).toContain('"id":2');
    expect(received).toContain('"id":3');
    expect(received).not.toContain(SECRET);
    expect(received).not.toContain("/work");
    expect(received).not.toContain("/review");
  });
});
