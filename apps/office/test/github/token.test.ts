// App の鍵。GitHub を呼ぶたびに、リポジトリ 1 つと要る権限だけに絞った 1 時間の鍵をゲートウェイが作って付ける (タスクとレビューの 3.3)
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MINUTE, rows, useWork } from "../helpers/work.ts";
import { loadLink } from "../../src/gate/github/app.ts";
import { connect, fromWorkspace, push, pushBody, startTask, stepUp, urlOf } from "../helpers/github.ts";

const world = useWork();

const UI = "example/knowidea-ui";
const OFFICE = "example/know-office";
const Problem = z.object({ code: z.string() }).loose();

/**
 * 代わりの GitHub が出した鍵を、出した順に並べる
 * @returns 届くリポジトリ、権限、期限
 */
function minted() {
  return [...world.gate.github.tokens.values()];
}

/**
 * 代わりの GitHub の git の受け口に届いた要求
 * @returns 「メソッド パス」
 */
function gitRequests(): string[] {
  return world.gate.github.requests.filter((r) => r.route.includes(".git/")).map((r) => r.route);
}

/**
 * ワークスペースの git と同じ形の push の要求を作る
 * @param token 作業トークン
 * @param body 本文
 * @param headers 足すヘッダー
 * @returns 要求
 */
function gitPost(token: string, body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}`, "content-type": "application/x-git-receive-pack-request", ...headers },
    body,
    // 流れの本文は Node では duplex が要る
    duplex: "half",
  };
  return new Request(`https://github.com/${UI}.git/git-receive-pack`, init);
}

/**
 * ワークスペースから api.github.com を呼ぶ
 * @param work 送る社員と作業トークン
 * @param work.staffId 社員 ID
 * @param work.token 作業トークン
 * @param method メソッド
 * @param path 道
 * @returns 受け手の返事
 */
function api(work: { staffId: "builder"; token: string }, method: string, path: string): Promise<Response> {
  return fromWorkspace(world, work, new Request(`https://api.github.com${path}`, { method, headers: { authorization: `Bearer ${work.token}` }, ...(method === "GET" ? {} : { body: "{}" }) }));
}

describe("App の鍵", () => {
  it("絞った鍵", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, body: await res.text() }).toEqual({ status: 200, body: "fake-git" });
    // knowidea-ui だけに書ける、1 時間の鍵
    expect(minted()).toEqual([{ installationId: expect.any(Number) as unknown, repos: [UI], permissions: { contents: "write" }, expiresAt: world.clock.now() + 60 * MINUTE }]);
    const sent = world.gate.github.requests.filter((r) => r.route === `POST /${UI}.git/git-receive-pack`);
    expect(sent.map((r) => r.token)).toEqual([[...world.gate.github.tokens.keys()][0]]);
    // ワークスペースに GitHub の鍵を返さない
    expect(sent[0]?.token).not.toBe(work.token);
    expect(world.gate.audits.filter((a) => a.action === "github.push")).toEqual([
      expect.objectContaining({ actor: "builder", target: UI, detail: { nodeId: work.nodeId, refs: ["refs/heads/ko/x"], status: 200 } }),
    ]);
  });

  it("選んでいないリポジトリ", async () => {
    await connect(world);
    // インストールで選んでいないリポジトリ。鍵を作る時に GitHub が断る
    const outside = await startTask(world, "example/private-notes");
    const res = await push(world, outside, "example/private-notes", [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    // 触れるリポジトリを knowidea-ui に絞ると、know-office は鍵を作る前に断る
    await stepUp(world);
    // 非公開なのでルールセットは掛けない
    world.gate.github.set(`GET /repos/${UI}`, { private: true, default_branch: "main" });
    const put = await world.gate.request("/api/v1/github/rules", { method: "PUT", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ version: 0, repos: [UI], reason: "knowidea-ui だけ" }) });
    expect(put.status).toBe(200);
    const before = minted().length;
    const office = await startTask(world, OFFICE, "reviewer");
    const denied = await push(world, office, OFFICE, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: denied.status, code: Problem.parse(await denied.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(minted().length).toBe(before);
    expect(gitRequests()).toEqual([]);
    const read = await api({ staffId: "builder", token: outside.token }, "GET", `/repos/${OFFICE}/pulls`);
    expect(read.status).toBe(403);
  });

  it("ワークスペースからの api.github.com は選んだリポジトリへの GET を、読む鍵で通す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.set(`GET /repos/${UI}/pulls`, [{ number: 1 }]);
    const read = await api({ staffId: "builder", token: work.token }, "GET", `/repos/${UI}/pulls`);
    expect({ status: read.status, body: z.unknown().parse(await read.json()) }).toEqual({ status: 200, body: [{ number: 1 }] });
    expect(minted().at(-1)).toMatchObject({ repos: [UI], permissions: { pull_requests: "read" } });
  });
  it("全体が止まる", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    expect((await push(world, work, UI, [{ ref: "refs/heads/ko/x" }])).status).toBe(200);
    const issued = [...world.gate.github.tokens.keys()];
    expect(issued.length).toBe(1);
    const res = await world.gate.request("/api/v1/guard/stops", { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "office", target: "office", reason: "確かめ" }) });
    expect(res.status).toBe(201);
    // 発行した 1 時間の鍵を GitHub の側で取り消し、ためた鍵を捨てる
    expect(world.gate.github.revoked).toEqual(issued);
    expect(world.gate.githubCache.size).toBe(0);
    // 元の鍵は取り替えられ、know-office で使えない
    expect((await loadLink(world.gate.env)).app).toBeNull();
  });

  it("全体を止める時は、鍵を取り替えて外の鍵を止めてから 1 時間の鍵を取り消す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    expect((await push(world, work, UI, [{ ref: "refs/heads/ko/x" }])).status).toBe(200);
    const real = world.gate.github.app.request.bind(world.gate.github.app);
    const atRevoke: { rotated: boolean; held: boolean }[] = [];
    const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) => {
      if (urlOf(input).includes("/installation/token") && init?.method === "DELETE") atRevoke.push({ rotated: (await loadLink(world.gate.env)).app === null, held: await world.gate.office.keysHeld() });
      return real(input, init, ...rest);
    });
    const res = await world.gate.request("/api/v1/guard/stops", { method: "POST", headers: { ...world.headers, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "office", target: "office", reason: "確かめ" }) });
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(atRevoke).toEqual([{ rotated: true, held: true }]);
  });

  it("同じ組の鍵は 50 分ためる", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const fetchRefs = () =>
      fromWorkspace(world, work, new Request(`https://github.com/${UI}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`x-access-token:${work.token}`)}` } }));
    expect((await fetchRefs()).status).toBe(200);
    world.clock.advance(50 * MINUTE - 1);
    await world.gate.staff.builder.book.heartbeat(world.clock.now());
    expect((await fetchRefs()).status).toBe(200);
    expect(minted().length).toBe(1);
    world.clock.advance(1);
    expect((await fetchRefs()).status).toBe(200);
    expect(minted().length).toBe(2);
  });

  it("失効した作業トークンでは push できない", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    await world.gate.staff.builder.guard.revokeTokens([work.jti]);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect(res.status).toBe(401);
    expect(minted()).toEqual([]);
  });

  it("連携していない時は鍵を作らず断る", async () => {
    const work = await startTask(world, UI);
    const res = await push(world, work, UI, [{ ref: "refs/heads/ko/x" }]);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
    expect(await rows(world.d1.DB, "SELECT name FROM vault WHERE name LIKE 'github_%'")).toEqual([]);
  });
});

describe("ゲートウェイが断る GitHub の操作", () => {
  const cases: { name: string; repo: string; updates: { ref: string; from?: string; to?: string }[]; defaultBranch?: string }[] = [
    { name: "main への push", repo: UI, updates: [{ ref: "refs/heads/ko/ok" }, { ref: "refs/heads/main" }] },
    { name: "大文字の MAIN への push", repo: UI, updates: [{ ref: "refs/heads/MAIN" }] },
    { name: "既定のブランチへの push", repo: UI, updates: [{ ref: "refs/heads/develop" }], defaultBranch: "develop" },
    { name: "refs/heads/ でない ref の push", repo: UI, updates: [{ ref: "refs/for/main" }] },
    { name: "// を含む ref の push", repo: UI, updates: [{ ref: "refs/heads/ko//x" }] },
    { name: ".. を含む ref の push", repo: UI, updates: [{ ref: "refs/heads/ko/../main" }] },
    { name: "/ で終わる ref の push", repo: UI, updates: [{ ref: "refs/heads/ko/" }] },
    { name: ".lock で終わる ref の push", repo: UI, updates: [{ ref: "refs/heads/ko/x.lock" }] },
    { name: "使えない文字を含む ref の push", repo: UI, updates: [{ ref: "refs/heads/ko/x~1" }] },
    { name: "ブランチを消す push", repo: UI, updates: [{ ref: "refs/heads/ko/old", from: "d".repeat(40), to: "0".repeat(40) }] },
    { name: "タグの push", repo: UI, updates: [{ ref: "refs/tags/v1" }] },
    { name: "タスクのでないリポジトリへの push", repo: OFFICE, updates: [{ ref: "refs/heads/ko/x" }] },
  ];
  it.each(cases)("$name", async (c) => {
    await connect(world);
    if (c.defaultBranch !== undefined) world.gate.github.defaultBranches.set(UI, c.defaultBranch);
    const work = await startTask(world, UI);
    const res = await push(world, work, c.repo, c.updates);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(gitRequests()).toEqual([]);
    // ルールの外の操作として数え、そのタスクを止める
    expect(await rows(world.d1.DB, "SELECT status FROM nodes WHERE id = ?", work.nodeId)).toEqual([{ status: "stopped" }]);
  });

  const writes = [
    { name: "api.github.com に書く", method: "POST", path: `/repos/${UI}/pulls` },
    { name: "api.github.com のリポジトリの外を読む", method: "GET", path: "/user" },
  ];
  it.each(writes)("$name", async ({ method, path }) => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await api({ staffId: "builder", token: work.token }, method, path);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 403, code: "rule_denied" });
    expect(minted()).toEqual([]);
  });
});

describe("ワークスペースの git の push", () => {
  it("shallow の行の後に命令がある push は通す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const shallow = `shallow ${"e".repeat(40)}\n`;
    const head = `${(shallow.length + 4).toString(16).padStart(4, "0")}${shallow}`;
    const body = new Uint8Array([...new TextEncoder().encode(head), ...pushBody([{ ref: "refs/heads/ko/x" }])]);
    const res = await fromWorkspace(world, work, gitPost(work.token, body));
    expect(res.status).toBe(200);
    expect(world.gate.github.gitBodies.at(-1)?.bytes).toBe(body.byteLength);
  });

  it("壊れた pkt-line (長さが 16 進数でない、頭に符号がある、4 より小さい、本文より長い、flush が無い、命令の形が違う) は 400 で、GitHub に送らない", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const cases = [
      { name: "長さが 16 進数でない", body: "zzzz" },
      { name: "長さの頭に符号がある", body: `+066${"0".repeat(40)} ${"c".repeat(40)} refs/heads/ko/x\n0000` },
      { name: "長さが 4 より小さい", body: "0003" },
      { name: "長さが本文より長い", body: "00ff0000" },
      { name: "flush が無い", body: `0067${"0".repeat(40)} ${"c".repeat(40)} refs/heads/ko/x\n` },
      { name: "命令の形が違う", body: "0010not-a-cmd\n0000" },
    ];
    const answers: Record<string, unknown> = {};
    for (const { name, body } of cases) {
      const res = await fromWorkspace(world, work, gitPost(work.token, new TextEncoder().encode(body)));
      answers[name] = { status: res.status, code: Problem.parse(await res.json()).code };
    }
    expect(answers).toEqual(Object.fromEntries(cases.map((c) => [c.name, { status: 400, code: "malformed_request" }])));
    expect(gitRequests()).toEqual([]);
  });

  it("命令だけを読み、残りは流して送る。gzip は解いて送り、Content-Encoding を引き継がない", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const body = new Uint8Array([...pushBody([{ ref: "refs/heads/ko/x" }]), ...new Uint8Array(3 * 1024 * 1024).fill(7)]);
    const res = await fromWorkspace(world, work, gitPost(work.token, new Uint8Array(gzipSync(body)), { "content-encoding": "gzip" }));
    expect(res.status).toBe(200);
    expect(world.gate.github.gitBodies.at(-1)).toEqual({ route: `POST /${UI}.git/git-receive-pack`, bytes: body.byteLength, encoding: null });
  });

  it("Content-Length が 100MB を超える push は読まずに 413", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const res = await fromWorkspace(world, work, gitPost(work.token, pushBody([{ ref: "refs/heads/ko/x" }]), { "content-length": String(100 * 1024 * 1024 + 1) }));
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 413, code: "payload_too_large" });
    expect(gitRequests()).toEqual([]);
  });

  it("流した量が 100MB を超えると 413", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    const commands = pushBody([{ ref: "refs/heads/ko/x" }]);
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = -1;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < 0) {
          controller.enqueue(commands);
          sent = 0;
          return;
        }
        if (sent > 101 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await fromWorkspace(world, work, gitPost(work.token, stream));
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 413, code: "payload_too_large" });
  });
});

describe("頼んだより広い鍵は使わない", () => {
  const replies: { name: string; mint: NonNullable<typeof world.gate.github.nextMint> }[] = [
    { name: "別のリポジトリの鍵", mint: { repositories: [{ full_name: OFFICE }] } },
    { name: "頼んでいない権限を持つ鍵", mint: { permissions: { pull_requests: "read", contents: "write" } } },
    { name: "頼んだ権限が足りない鍵", mint: { permissions: { metadata: "read" } } },
  ];
  it.each(replies)("$name", async ({ mint }) => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.set(`GET /repos/${UI}/pulls`, [{ number: 1 }]);
    world.gate.github.nextMint = mint;
    const res = await api({ staffId: "builder", token: work.token }, "GET", `/repos/${UI}/pulls`);
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
    // 受けた鍵で GitHub を呼ばず、ためない
    expect(world.gate.github.requests.filter((r) => r.route === `GET /repos/${UI}/pulls`)).toEqual([]);
    expect(world.gate.githubCache.size).toBe(0);
  });
});

describe("App を通した操作を記録する (ワークスペース)", () => {
  it("読む git と api.github.com の GET も記録に残す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    world.gate.github.set(`GET /repos/${UI}/pulls`, []);
    await fromWorkspace(world, work, new Request(`https://github.com/${UI}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`x-access-token:${work.token}`)}` } }));
    await api({ staffId: "builder", token: work.token }, "GET", `/repos/${UI}/pulls`);
    expect(world.gate.audits.filter((a) => a.action === "github.read").map((a) => ({ actor: a.actor, target: a.target, detail: a.detail }))).toEqual([
      { actor: "builder", target: UI, detail: { nodeId: work.nodeId, via: "git", path: "info/refs", status: 200 } },
      { actor: "builder", target: UI, detail: { nodeId: work.nodeId, via: "api", path: "/pulls", status: 200 } },
    ]);
  });

  it("push は失敗も記録に残し、ref の長さを切る", async () => {
    await connect(world);
    const work = await startTask(world, UI, "builder", { branch: `ko/${"a".repeat(600)}` });
    world.gate.github.gitStatus = 500;
    const long = `refs/heads/ko/${"a".repeat(600)}`;
    const res = await push(world, work, UI, [{ ref: long }]);
    expect(res.status).toBe(500);
    const [entry] = world.gate.audits.filter((a) => a.action === "github.push");
    const detail = z.object({ nodeId: z.string(), refs: z.array(z.string()), status: z.number() }).parse(entry?.detail);
    expect({ nodeId: detail.nodeId, status: detail.status }).toEqual({ nodeId: work.nodeId, status: 500 });
    expect(detail.refs[0]?.length).toBeLessThan(long.length);
  });
});

describe("GitHub の 3xx は追わない", () => {
  it.each([
    { name: "git", route: `/${UI}.git/info/refs`, call: (token: string) => new Request(`https://github.com/${UI}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Basic ${btoa(`x-access-token:${token}`)}` } }) },
    { name: "api.github.com", route: `/repos/${UI}/pulls`, call: (token: string) => new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${token}` } }) },
  ])("$name", async ({ route, call }) => {
    await connect(world);
    const work = await startTask(world, UI);
    const real = world.gate.github.app.request.bind(world.gate.github.app);
    const seen: (string | undefined)[] = [];
    const spy = vi.spyOn(world.gate.github.app, "request").mockImplementation(async (input, init, ...rest) => {
      if (!urlOf(input).includes(route)) return real(input, init, ...rest);
      seen.push(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    });
    const res = await fromWorkspace(world, work, call(work.token));
    spy.mockRestore();
    expect({ status: res.status, code: Problem.parse(await res.json()).code }).toEqual({ status: 502, code: "upstream_failed" });
    expect(seen).toEqual(["manual"]);
  });
});
