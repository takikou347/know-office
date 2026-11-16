// 利用場面の通しで GitHub をつなぐ。画面を使わず、ゲートウェイの API (つなぐ、App の受け取り、インストールの受け取り) と手元の代わりの GitHub で、オーナーがつないだのと同じ状態にする
import type { Page } from "@playwright/test";
import { z } from "zod";
import { seedMain } from "./seed.ts";

/** 手元の代わりの GitHub */
export const FAKE_GITHUB = "http://127.0.0.1:5199/github";

const Connect = z.object({ data: z.object({ action: z.url(), manifest: z.record(z.string(), z.unknown()).nullable() }).loose() }).loose();

/** 前のテストがつないだ GitHub を金庫から消す。各テストの頭で呼び、つなぎ直す */
export function forgetGitHub(): void {
  seedMain("DELETE FROM vault WHERE name IN ('github_app', 'github_installation')");
}

/**
 * ブラウザーの中で、画面と同じ手順でパスキーを確かめる。useOwnerPasskey で認証器を付けたページで呼ぶ
 * @param page 開いているページ
 */
async function stepUp(page: Page): Promise<void> {
  const ok = await page.evaluate(async () => {
    const options = await fetch("/api/v1/passkeys/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "step_up" }) });
    const body: unknown = await options.json();
    // WebAuthn の JSON の形はブラウザーの parseRequestOptionsFromJSON が確かめ、違えば投げる
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const json = (body as { data: PublicKeyCredentialRequestOptionsJSON }).data;
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(json) });
    if (!(credential instanceof PublicKeyCredential)) return false;
    const res = await fetch("/api/v1/me/step-up", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential.toJSON()) });
    return res.ok;
  });
  if (!ok) throw new Error("パスキーで確かめられない");
}

/**
 * 次の行き先を読む。302 でなければ投げる
 * @param res 返事
 * @param res.status ステータス
 * @param res.headers 見出し
 * @returns 行き先
 */
function locationOf(res: { status(): number; headers(): Record<string, string> }): string {
  const to = res.headers()["location"];
  if (res.status() !== 302 || to === undefined) throw new Error(`302 でない: ${String(res.status())}`);
  return to;
}

/**
 * GitHub をつなぐ。前につないだ物を消し、パスキーで確かめ、App を作ってリポジトリに入れる。画面を 1 度開き、useOwnerPasskey を付けたページで呼ぶ
 * @param page 開いているページ
 */
export async function connectGitHub(page: Page): Promise<void> {
  forgetGitHub();
  await stepUp(page);
  const origin = new URL(page.url()).origin;
  const res = await page.request.post("/api/v1/github/connect", { headers: { Origin: origin } });
  if (!res.ok()) throw new Error(`つなぎ始められない: ${String(res.status())}`);
  const { action, manifest } = Connect.parse(await res.json()).data;
  // GitHub の App を作る画面で「作成」を押したのと同じ form を送り、戻り先を順に開く
  const made = await page.request.post(action, { form: { manifest: JSON.stringify(manifest) }, maxRedirects: 0 });
  const install = await page.request.get(locationOf(made), { maxRedirects: 0 });
  const installed = await page.request.get(locationOf(install), { maxRedirects: 0 });
  const done = await page.request.get(locationOf(installed), { maxRedirects: 0 });
  if (locationOf(done) !== "/settings") throw new Error("インストールを受け取れない");
}

/**
 * 代わりの GitHub に、決まった道の返事を置く
 * @param page 開いているページ
 * @param route 「メソッド 道」
 * @param body 返す JSON
 */
export async function fakeGitHubRoute(page: Page, route: string, body: unknown): Promise<void> {
  const res = await page.request.post(`${FAKE_GITHUB}/__fake/routes`, { data: { route, body } });
  if (!res.ok()) throw new Error(`返事を置けない: ${route}`);
}
