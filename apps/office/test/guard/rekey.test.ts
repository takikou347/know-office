// 全体を止めた後の鍵。止まっている間はプロキシが外へ出さず、オーナーが GitHub App と Claude の鍵を入れ直すと全体を再開できる (自動停止の 3.3、3.4)
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ANTHROPIC_KEY } from "../helpers/gate.ts";
import { connect, createGitHubApp, fromWorkspace, hook, onGitHub, push, returnFromGitHub, startTask, stepUp, type Work, wrapDb } from "../helpers/github.ts";
import { rows, useWork } from "../helpers/work.ts";

const world = useWork();

const UI = "example/knowidea-ui";
const NEW_CLAUDE_KEY = `sk-ant-api03-${"n".repeat(40)}`;
const NEW_WEBHOOK_SECRET = "whsec-new-0123456789abcdef";
const Problem = z.object({ code: z.string() }).loose();
const Data = z.object({ data: z.unknown() }).loose();

/**
 * ルートを呼ぶ。本文があれば JSON で送る
 * @param method メソッド
 * @param path パス
 * @param body 本文
 * @returns 返事
 */
function call(method: string, path: string, body?: unknown): Promise<Response> {
  return world.gate.request(path, {
    method,
    headers: { ...world.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * 返事のステータスと、data か code を読む
 * @param res 返事
 * @returns ステータスと中身
 */
async function answer(res: Response): Promise<{ status: number; body: unknown }> {
  const json: unknown = await res.json();
  return { status: res.status, body: res.ok ? Data.parse(json).data : Problem.parse(json).code };
}

/**
 * 手で全体を止め、切れたセッションの代わりにログインし直してパスキーで確かめる
 * @returns 止めた記録の ID
 */
async function stopOffice(): Promise<string> {
  const res = await call("POST", "/api/v1/guard/stops", { scope: "office", target: "office", reason: "確かめ" });
  expect(res.status).toBe(201);
  world.headers = await world.gate.signIn();
  await stepUp(world);
  return z.object({ data: z.object({ stopId: z.string() }) }).parse(await res.json()).data.stopId;
}

/**
 * ワークスペースの SDK と同じ形で Claude を呼ぶ
 * @param work 社員と作業トークン
 * @returns 受け手の返事
 */
async function callClaude(work: Work): Promise<Response> {
  await world.gate.staff[work.staffId].book.heartbeat(world.clock.now());
  return fromWorkspace(
    world,
    work,
    new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": work.token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: [{ role: "user", content: "直す" }] }),
    }),
  );
}

/**
 * ワークスペースから api.github.com を読む
 * @param work 社員と作業トークン
 * @returns 受け手の返事
 */
function readApi(work: Work): Promise<Response> {
  return fromWorkspace(world, work, new Request(`https://api.github.com/repos/${UI}/pulls`, { headers: { authorization: `Bearer ${work.token}` } }));
}

/**
 * GitHub App の画面で秘密鍵を作り直す。前の秘密鍵は消す
 * @param appId App ID
 * @returns 新しい秘密鍵 (PKCS#1 の PEM)
 */
function newPrivateKey(appId: number): string {
  return world.gate.github.newPrivateKey(appId);
}

describe("止めるのはシステム", () => {
  it("全体が止まっている間は、git、api.github.com、Claude の API を断り、外へ届けない", async () => {
    await connect(world);
    const before = await startTask(world, UI);
    await stopOffice();
    // 止める前に出した作業トークンも、止めた後に出た作業トークンも、外へは出さない
    const after = await startTask(world, UI);
    const sent = { github: world.gate.github.requests.length, claude: world.gate.claude.keys.length };
    // 止める前の作業トークンは、作業トークンの署名の鍵を取り替えたので通らない
    const old = [await push(world, before, UI, [{ ref: "refs/heads/ko/x" }]), await readApi(before), await callClaude(before)];
    expect(old.map((r) => r.status)).toEqual([401, 401, 401]);
    for (const res of [await push(world, after, UI, [{ ref: "refs/heads/ko/x" }]), await readApi(after), await callClaude(after)]) {
      expect(await answer(res)).toEqual({ status: 409, body: "stopped" });
    }
    expect({ github: world.gate.github.requests.length, claude: world.gate.claude.keys.length }).toEqual(sent);
  });
});

describe("再開", () => {
  it("全体を止めた後の鍵の入れ直し", async () => {
    const linked = await connect(world);
    const stopId = await stopOffice();
    const resume = () => call("POST", `/api/v1/guard/stops/${stopId}/resume`);
    expect(await answer(await call("GET", "/api/v1/guard/keys"))).toEqual({ status: 200, body: { held: true, pending: ["github_app", "claude"] } });

    // GitHub App の画面で秘密鍵と通知の秘密を作り直して入れる
    const privateKey = newPrivateKey(linked.appId);
    expect(await answer(await call("PUT", "/api/v1/guard/keys/github-app", { privateKey, webhookSecret: NEW_WEBHOOK_SECRET }))).toEqual({ status: 200, body: { held: true, pending: ["claude"] } });
    expect(await answer(await resume())).toEqual({ status: 409, body: "conflict" });

    expect(await answer(await call("PUT", "/api/v1/guard/keys/claude", { apiKey: NEW_CLAUDE_KEY }))).toEqual({ status: 200, body: { held: false, pending: [] } });
    expect((await resume()).status).toBe(200);
    expect(world.gate.audits.map((a) => a.action).filter((a) => a.startsWith("guard.keys"))).toEqual(["guard.keys_replaced", "guard.keys_replaced"]);

    // 再開した後は、入れ直した鍵だけを使う
    const work = await startTask(world, UI);
    expect((await push(world, work, UI, [{ ref: "refs/heads/ko/x" }])).status).toBe(200);
    world.gate.claude.push({ content: [{ type: "text", text: "直した" }] });
    expect((await callClaude(work)).status).toBe(200);
    expect(world.gate.claude.keys.at(-1)).toBe(NEW_CLAUDE_KEY);
    expect(world.gate.claude.keys).not.toContain(ANTHROPIC_KEY);
    // 止める前の通知の秘密で署名した通知は通らない
    const ping = { action: "created", installation: { id: linked.installationId } };
    expect((await hook(world, { event: "ping", payload: ping, secret: linked.webhookSecret })).status).toBe(401);
    expect((await hook(world, { event: "ping", payload: ping, secret: NEW_WEBHOOK_SECRET })).status).toBe(204);
  });

  it("連携をやり直しても GitHub App の鍵を入れ直した事になる", async () => {
    await connect(world);
    await stopOffice();
    const callback = await createGitHubApp(world);
    const toInstall = await returnFromGitHub(world, callback);
    expect(toInstall.status).toBe(302);
    const installed = await onGitHub(world, toInstall.headers.get("location") ?? "");
    expect((await returnFromGitHub(world, installed.headers.get("location") ?? "")).status).toBe(302);
    expect(await answer(await call("GET", "/api/v1/guard/keys"))).toEqual({ status: 200, body: { held: true, pending: ["claude"] } });
  });

  it("パスキーで確かめなければ入れ直せない", async () => {
    await connect(world);
    await stopOffice();
    await world.d1.DB.prepare("UPDATE sessions SET step_up_until = NULL").run();
    // 入力を確かめる前に断る
    for (const [path, body] of [
      ["/api/v1/guard/keys/github-app", { privateKey: "x" }],
      ["/api/v1/guard/keys/claude", { apiKey: "x" }],
    ] as const) {
      expect(await answer(await call("PUT", path, body))).toEqual({ status: 401, body: "step_up_required" });
    }
    expect(await answer(await call("GET", "/api/v1/guard/keys"))).toEqual({ status: 200, body: { held: true, pending: ["github_app", "claude"] } });
  });

  it("全体が止まっていなければ入れ直せない", async () => {
    const linked = await connect(world);
    await stepUp(world);
    expect(await answer(await call("GET", "/api/v1/guard/keys"))).toEqual({ status: 200, body: { held: false, pending: [] } });
    expect(await answer(await call("PUT", "/api/v1/guard/keys/claude", { apiKey: NEW_CLAUDE_KEY }))).toEqual({ status: 409, body: "conflict" });
    const privateKey = newPrivateKey(linked.appId);
    expect(await answer(await call("PUT", "/api/v1/guard/keys/github-app", { privateKey, webhookSecret: NEW_WEBHOOK_SECRET }))).toEqual({ status: 409, body: "conflict" });
    expect(await rows(world.d1.DB, "SELECT name FROM vault WHERE name = 'claude_api_key'")).toEqual([]);
  });

  it("形の違う鍵と、App と合わない秘密鍵は入れない", async () => {
    await connect(world);
    await stopOffice();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
    const cases: [string, unknown][] = [
      ["/api/v1/guard/keys/claude", { apiKey: "sk-proj-0123456789abcdefghij" }],
      ["/api/v1/guard/keys/claude", { apiKey: `sk-ant-${"a".repeat(19)}` }],
      ["/api/v1/guard/keys/claude", { apiKey: NEW_CLAUDE_KEY, extra: 1 }],
      ["/api/v1/guard/keys/github-app", { privateKey: "-----BEGIN RSA PRIVATE KEY-----\n!!!\n-----END RSA PRIVATE KEY-----", webhookSecret: NEW_WEBHOOK_SECRET }],
      ["/api/v1/guard/keys/github-app", { privateKey: other, webhookSecret: "short" }],
      ["/api/v1/guard/keys/github-app", { privateKey: other, webhookSecret: NEW_WEBHOOK_SECRET }],
    ];
    for (const [path, body] of cases) expect(await answer(await call("PUT", path, body))).toEqual({ status: 422, body: "validation_failed" });
    expect(await answer(await call("GET", "/api/v1/guard/keys"))).toEqual({ status: 200, body: { held: true, pending: ["github_app", "claude"] } });
  });

  it("インストールが外れていれば、連携をやり直すように断る", async () => {
    const linked = await connect(world);
    await stopOffice();
    world.gate.github.uninstall(linked.installationId);
    const privateKey = newPrivateKey(linked.appId);
    expect(await answer(await call("PUT", "/api/v1/guard/keys/github-app", { privateKey, webhookSecret: NEW_WEBHOOK_SECRET }))).toEqual({ status: 409, body: "conflict" });
    expect(await rows(world.d1.DB, "SELECT name FROM vault WHERE revoked_at IS NULL AND name LIKE 'github_%'")).toEqual([]);
  });

  it("同時に入れ直しても、置く鍵は 1 つ", async () => {
    const linked = await connect(world);
    await stopOffice();
    // 2 つを並べて送るだけでは、片方が終わってからもう片方が読む順になる事がある。先の 1 つが書く直前に、もう 1 つを通して重ねる
    const first: number[] = [];
    let overlapped = false;
    const restoreClaude = wrapDb(world, {
      batch: async (real, statements) => {
        if (!overlapped) {
          overlapped = true;
          first.push((await call("PUT", "/api/v1/guard/keys/claude", { apiKey: `sk-ant-api03-${"m".repeat(40)}` })).status);
        }
        return real(statements);
      },
    });
    const second = await call("PUT", "/api/v1/guard/keys/claude", { apiKey: NEW_CLAUDE_KEY });
    restoreClaude();
    expect(first).toEqual([200]);
    expect(await answer(second)).toEqual({ status: 409, body: "conflict" });
    expect(await rows(world.d1.DB, "SELECT COUNT(*) AS n FROM vault WHERE name = 'claude_api_key' AND revoked_at IS NULL")).toEqual([{ n: 1 }]);

    // GitHub App の鍵は、App とインストールの 2 つを 1 回のバッチで置く。書く直前に別の入れ直しを通しても、片方だけを残さない
    const privateKey = newPrivateKey(linked.appId);
    const between: number[] = [];
    let raced = false;
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        if (!raced) {
          raced = true;
          between.push((await call("PUT", "/api/v1/guard/keys/github-app", { privateKey, webhookSecret: NEW_WEBHOOK_SECRET })).status);
        }
        return real(statements);
      },
    });
    const late = await call("PUT", "/api/v1/guard/keys/github-app", { privateKey, webhookSecret: NEW_WEBHOOK_SECRET });
    restore();
    expect(between).toEqual([200]);
    expect(await answer(late)).toEqual({ status: 409, body: "conflict" });
    expect(await rows(world.d1.DB, "SELECT name, COUNT(*) AS n FROM vault WHERE revoked_at IS NULL AND name LIKE 'github_%' GROUP BY name ORDER BY name")).toEqual([
      { name: "github_app", n: 1 },
      { name: "github_installation", n: 1 },
    ]);
  });

  it("止まっている事を確かめた後に再開されたら、鍵を置かない", async () => {
    await connect(world);
    const stopId = await stopOffice();
    const restore = wrapDb(world, {
      batch: async (real, statements) => {
        // 書く直前に、全体の止めた記録に resumed を足す
        await world.d1.DB.prepare("INSERT INTO stop_updates (id, stop_id, at, kind, by, reason) VALUES (?, ?, ?, 'resumed', 'owner', NULL)").bind(crypto.randomUUID(), stopId, world.clock.now()).run();
        return real(statements);
      },
    });
    const res = await call("PUT", "/api/v1/guard/keys/claude", { apiKey: NEW_CLAUDE_KEY });
    restore();
    expect(await answer(res)).toEqual({ status: 409, body: "conflict" });
    expect(await rows(world.d1.DB, "SELECT name FROM vault WHERE name = 'claude_api_key'")).toEqual([]);
  });

  it("入れ直している間に全体を止め直したら、印は外さない", async () => {
    await world.gate.office.holdKeys();
    const { generation } = await world.gate.office.keyState();
    await world.gate.office.holdKeys();
    expect(await world.gate.office.releaseKeys("claude", generation)).toEqual({ held: true, pending: ["github_app", "claude"] });
    const now = await world.gate.office.keyState();
    expect(await world.gate.office.releaseKeys("claude", now.generation)).toEqual({ held: true, pending: ["github_app"] });
    expect(await world.gate.office.releaseKeys("github_app", now.generation)).toEqual({ held: false, pending: [] });
  });

  it("全体を止める時に鍵の取り替えが落ちても、外の鍵の印を付け、1 時間の鍵を取り消す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    expect((await push(world, work, UI, [{ ref: "refs/heads/ko/x" }])).status).toBe(200);
    const issued = [...world.gate.github.tokens.keys()];
    // 取り替えの新しい版を書く所で落とす
    const restore = wrapDb(world, {
      prepare: (real, sql) => {
        if (/^insert into "vault"/i.test(sql)) throw new Error("取り替えを落とす");
        return real(sql);
      },
    });
    const res = await call("POST", "/api/v1/guard/stops", { scope: "office", target: "office", reason: "確かめ" });
    restore();
    expect(res.status).toBe(500);
    expect((await world.gate.office.keyState()).held).toBe(true);
    expect(world.gate.github.revoked).toEqual(issued);
  });

  it("鍵の取り替えと外の鍵の印の両方が落ちても、取り替えの失敗を残し、印の失敗も記録して、1 時間の鍵を取り消す", async () => {
    await connect(world);
    const work = await startTask(world, UI);
    expect((await push(world, work, UI, [{ ref: "refs/heads/ko/x" }])).status).toBe(200);
    const issued = [...world.gate.github.tokens.keys()];
    const restore = wrapDb(world, {
      prepare: (real, sql) => {
        if (/^insert into "vault"/i.test(sql)) throw new Error("取り替えを落とす");
        return real(sql);
      },
    });
    // エラーログはテストの間で消えないので、ここから後の行だけを見る
    const seen = Number((await rows(world.d1.REC_2026, "SELECT COALESCE(MAX(rowid), 0) AS n FROM error_events"))[0]?.["n"]);
    const hold = vi.spyOn(world.gate.env.GUARD.get(world.gate.env.GUARD.idFromName("guard")), "holdKeys").mockRejectedValue(new Error("印を落とす"));
    const res = await call("POST", "/api/v1/guard/stops", { scope: "office", target: "office", reason: "確かめ" });
    restore();
    hold.mockRestore();
    expect(res.status).toBe(500);
    expect(world.gate.github.revoked).toEqual(issued);
    const errors = (await rows(world.d1.REC_2026, "SELECT rowid AS n, code, message FROM error_events")).filter((e) => Number(e["n"]) > seen);
    // 印の失敗は別の行に残り、止める動きの失敗には元の取り替えの失敗が残る
    expect(errors.map((e) => String(e["code"])).toSorted()).toEqual(["guard_keys_hold_failed", "guard_stop_failed", "internal"]);
    expect(errors.find((e) => e["code"] === "guard_stop_failed")?.["message"]).toContain("取り替えを落とす");
    expect(errors.find((e) => e["code"] === "guard_keys_hold_failed")?.["message"]).toContain("印を落とす");
  });

  it("全体を止めると、外の鍵は取り消すだけで新しい版を作らない", async () => {
    await connect(world);
    await stopOffice();
    expect(await rows(world.d1.DB, "SELECT name, version, revoked_at IS NULL AS live FROM vault WHERE name LIKE 'github_%' ORDER BY name, version")).toEqual([
      { name: "github_app", version: 1, live: 0 },
      { name: "github_installation", version: 1, live: 0 },
    ]);
  });
});
