// エディタの補完の木を GitHub の tarball から取る。読む鍵で取り、302 は 1 回だけ手で追い、codeload の先には鍵を付けない (タスクとレビューの 3.2)
import { gzipSync } from "node:zlib";
import { AppError, type Fetcher, LSP_TREE_BYTES } from "@know-office/core";
import { describe, expect, it } from "vitest";
import { createFakeGitHub } from "../../dev/github.ts";
import { type ArchiveDeps, openArchive } from "../../src/gate/github/archive.ts";

const REPO = "example/app";
const SHA = "c".repeat(40);
const API = "http://localhost:5199/github";
const FAKE_CODELOAD = "http://localhost:5199/codeload";
const TARBALL = gzipSync(Buffer.from("tar の中身"));
/** 読む鍵。代わりの GitHub が出した物の形 */
const READ_KEY = "ghs_fake_read";

/** 届いた要求 */
type Seen = { url: string; authorization: string | null; redirect: RequestRedirect | undefined };

/**
 * 流れを読み切る
 * @param stream 流れ
 * @returns 中身
 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/**
 * 代わりの GitHub と codeload につなぐ
 * @param options repos は読む鍵が届くリポジトリ
 * @param options.repos 届くリポジトリ
 * @returns 取り方と届いた要求
 */
function fakeWorld(options: { repos?: string[] } = {}): { deps: ArchiveDeps; seen: Seen[]; github: ReturnType<typeof createFakeGitHub> } {
  const github = createFakeGitHub({ codeloadBase: FAKE_CODELOAD });
  github.installations.set(1, { appId: 1, repos: options.repos ?? [REPO] });
  github.tokens.set(READ_KEY, { installationId: 1, repos: null, permissions: { contents: "read" }, expiresAt: Date.now() + 3_600_000 });
  github.archives.set(`${REPO}:${SHA}`, TARBALL);
  const seen: Seen[] = [];
  const fetcher: Fetcher = (url, init) => {
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url.startsWith(`${API}/`)) return Promise.resolve(github.app.request(url.slice(API.length), init));
    if (url.startsWith(`${FAKE_CODELOAD}/`)) return Promise.resolve(github.codeload.request(url.slice(FAKE_CODELOAD.length), init));
    return Promise.reject(new Error(`テストで外へ出た: ${url}`));
  };
  return { deps: { base: API, codeload: FAKE_CODELOAD, fetcher, access: { token: () => Promise.resolve(READ_KEY) } }, seen, github };
}

/**
 * 返事の URL が別のホストに替わった返事を作る
 * @returns 返事
 */
function moved(): Response {
  const res = new Response(TARBALL);
  Object.defineProperty(res, "url", { value: "https://evil.example.com/x" });
  return res;
}

/**
 * 読まれずに捨てられたかを覚える本文を作る
 * @returns 本文と、捨てられたか
 */
function watchedBody(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(16));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

/**
 * 本物の宛先の形で、302 の Location と 2 回目の返事を決めた GitHub につなぐ
 * @param location 302 の Location
 * @param second 2 回目の返事
 * @param firstBody 1 回目の 302 の本文
 * @returns 取り方と届いた要求
 */
function redirectWorld(location: string, second: () => Response = () => new Response(TARBALL), firstBody: ReadableStream<Uint8Array> | null = null): { deps: ArchiveDeps; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher: Fetcher = (url, init) => {
    seen.push({ url, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url.startsWith("https://api.github.com/")) return Promise.resolve(new Response(firstBody, { status: 302, headers: { location } }));
    return Promise.resolve(second());
  };
  return { deps: { base: "https://api.github.com", codeload: "https://codeload.github.com", fetcher, access: { token: () => Promise.resolve("ghs_test") } }, seen };
}

describe("読みやすさと補完", () => {
  it("tarball は読む鍵で取り、302 を 1 回だけ手で追う", async () => {
    const { deps, seen } = fakeWorld();
    const tokens: unknown[] = [];
    const body = await readAll(await openArchive({ ...deps, access: {
          token: (repo, permissions) => {
            tokens.push({ repo, permissions });
            return Promise.resolve(READ_KEY);
          },
        }, }, REPO, SHA));
    expect(body.equals(TARBALL)).toBe(true);
    expect(tokens).toEqual([{ repo: REPO, permissions: { contents: "read" } }]);
    expect(seen.map((s) => [s.url.split("?")[0], s.redirect])).toEqual([
      [`${API}/repos/${REPO}/tarball/${SHA}`, "manual"],
      [`${FAKE_CODELOAD}/${REPO}/legacy.tar.gz/${SHA}`, "manual"],
    ]);
  });

  it("302 の先への 2 回目の要求には Authorization を付けない", async () => {
    const { deps, seen } = fakeWorld();
    await readAll(await openArchive(deps, REPO, SHA));
    expect(seen.map((s) => s.authorization)).toEqual([`Bearer ${READ_KEY}`, null]);
  });

  it("302 の先のホストが codeload.github.com と完全一致でなければ断る", async () => {
    const locations = [
      "https://codeload.github.com.example.com/example/app/legacy.tar.gz/x",
      "https://evil.com/codeload.github.com/example/app/legacy.tar.gz/x",
      // 利用者名を付けた物。メールアドレスの形を残さないよう、@ を組み立てる
      ["https://user", "codeload.github.com/example/app/legacy.tar.gz/x"].join("@"),
      ["https://user:pass", "codeload.github.com/example/app/legacy.tar.gz/x"].join("@"),
      "http://codeload.github.com/example/app/legacy.tar.gz/x",
      "https://codeload.github.com:8443/example/app/legacy.tar.gz/x",
      "/example/app/legacy.tar.gz/x",
    ];
    const answers: string[] = [];
    for (const location of locations) {
      const { deps, seen } = redirectWorld(location);
      const error = await openArchive(deps, REPO, SHA).then(() => null, (e: unknown) => e);
      answers.push(`${error instanceof AppError ? error.code : "通った"} ${String(seen.length)}`);
    }
    expect(answers).toEqual(locations.map(() => "upstream_failed 1"));
    // 完全一致なら通る
    const { deps } = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x?token=t");
    expect((await readAll(await openArchive(deps, REPO, SHA))).equals(TARBALL)).toBe(true);
  });

  it("302 の先がもう 1 度リダイレクトを返したら断る", async () => {
    const { deps, seen } = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", () => new Response(null, { status: 302, headers: { location: "https://codeload.github.com/other" } }));
    // 2 度目の 302 は ok でないので後の確かめでも断るが、リダイレクトとして断る事を訳で確かめる
    await expect(openArchive(deps, REPO, SHA)).rejects.toMatchObject({ code: "upstream_failed", message: "codeload がもう 1 度リダイレクトした" });
    expect(seen).toHaveLength(2);
  });

  it("302 の先に利用者名かパスワードがあれば、宛先の比べより先に断る", async () => {
    for (const userinfo of ["user", "user:pw"]) {
      const { deps, seen } = redirectWorld([`https://${userinfo}`, "codeload.github.com/example/app/legacy.tar.gz/x"].join("@"));
      await expect(openArchive(deps, REPO, SHA)).rejects.toMatchObject({ code: "upstream_failed", message: "tarball の行き先が利用者名かパスワードを持つ" });
      expect(seen).toHaveLength(1);
    }
  });

  it("302 の本文と、断った 2 回目の本文は読まずに捨てる", async () => {
    const first = watchedBody();
    const ok = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", undefined, first.body);
    await readAll(await openArchive(ok.deps, REPO, SHA));
    expect(first.cancelled()).toBe(true);
    const failed = watchedBody();
    const bad = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", () => new Response(failed.body, { status: 500 }));
    await expect(openArchive(bad.deps, REPO, SHA)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(failed.cancelled()).toBe(true);
    const again = watchedBody();
    const redirected = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", () => new Response(again.body, { status: 302, headers: { location: "https://codeload.github.com/o" } }));
    await expect(openArchive(redirected.deps, REPO, SHA)).rejects.toMatchObject({ code: "upstream_failed" });
    expect(again.cancelled()).toBe(true);
  });

  it("302 の先の返事の URL が途中で別のホストに変わったら断る", async () => {
    const { deps } = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", moved);
    await expect(openArchive(deps, REPO, SHA)).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("見つからない sha は 404 を not_found に直す", async () => {
    const { deps } = fakeWorld();
    await expect(openArchive(deps, REPO, "d".repeat(40))).rejects.toMatchObject({ code: "not_found" });
  });

  it("tarball が 50MiB を超えたら流す途中で止める", async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const { deps } = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", () => new Response(big));
    const stream = await openArchive(deps, REPO, SHA);
    await expect(readAll(stream)).rejects.toMatchObject({ code: "upstream_failed" });
    // 宣言した長さが上限を超えれば、読まずに断る
    const declared = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", () => new Response(TARBALL, { headers: { "content-length": String(LSP_TREE_BYTES + 1) } }));
    await expect(openArchive(declared.deps, REPO, SHA)).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("50MiB ちょうどの tarball は通す", async () => {
    let left = LSP_TREE_BYTES;
    const exact = new ReadableStream<Uint8Array>({
      pull(controller) {
        const n = Math.min(left, 1024 * 1024);
        left -= n;
        if (n === 0) controller.close();
        else controller.enqueue(new Uint8Array(n));
      },
    });
    const { deps } = redirectWorld("https://codeload.github.com/example/app/legacy.tar.gz/x", () => new Response(exact));
    expect((await readAll(await openArchive(deps, REPO, SHA))).length).toBe(LSP_TREE_BYTES);
  });

  it("リポジトリと sha の形が違えば GitHub を呼ばずに断る", async () => {
    const { deps, seen } = fakeWorld();
    await expect(openArchive(deps, "../x", SHA)).rejects.toMatchObject({ code: "upstream_failed" });
    await expect(openArchive(deps, REPO, "C".repeat(40))).rejects.toMatchObject({ code: "upstream_failed" });
    await expect(openArchive(deps, REPO, "c".repeat(7))).rejects.toMatchObject({ code: "upstream_failed" });
    expect(seen).toEqual([]);
  });

  it("代わりの GitHub の tarball は本物と同じく鍵の無い要求を 401、届かないリポジトリを 404 で断る", async () => {
    const { github } = fakeWorld({ repos: ["example/other"] });
    const path = `/repos/${REPO}/tarball/${SHA}`;
    const ua = { "user-agent": "know-office" };
    expect((await github.app.request(path, { headers: ua })).status).toBe(401);
    expect((await github.app.request(path, { headers: { ...ua, authorization: `Bearer ${READ_KEY}` } })).status).toBe(404);
    // codeload の先も、出した印の無い要求と使った印を断る
    const ok = fakeWorld();
    const first = await ok.github.app.request(path, { headers: { ...ua, authorization: `Bearer ${READ_KEY}` }, redirect: "manual" });
    expect(first.status).toBe(302);
    const location = new URL(first.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${FAKE_CODELOAD}/${REPO}/legacy.tar.gz/${SHA}`);
    const local = `${location.pathname.slice("/codeload".length)}${location.search}`;
    expect((await ok.github.codeload.request(local.split("?")[0] ?? "")).status).toBe(404);
    expect((await ok.github.codeload.request(local, { headers: { authorization: "Bearer x" } })).status).toBe(400);
    expect((await ok.github.codeload.request(local)).status).toBe(200);
    expect((await ok.github.codeload.request(local)).status).toBe(404);
  });
});
