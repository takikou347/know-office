// アイデアとサービスの画面の通しで使う、画面の操作。案を足し、段階を移し、設計書のリポジトリを選び、試作まで進め、設定のカードを探す
import type { Page } from "@playwright/test";
import { expect } from "../../helpers/test.ts";
import { z } from "zod";
import { connectGitHub } from "./github.ts";
import { editCard, saveCard } from "./screen.ts";
import { freeRepoNames } from "./seed.ts";

/** 代わりの GitHub が初めから入れる非公開のリポジトリ 2 つ。設計書のリポジトリに交互に選ぶ */
const DOCS_REPOS = ["example/knowidea-docs", "example/other-docs"] as const;

/**
 * Knowidea-ui の選ぶ欄で 1 つ選ぶ
 * @param page 開いているページ
 * @param label 欄の名前
 * @param option 選ぶ物
 */
export async function choose(page: Page, label: string, option: string): Promise<void> {
  const box = page.getByRole("main").getByRole("combobox", { name: label });
  await box.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  // 選び肢の一覧が閉じ切る前に次の欄を押すと、次の一覧が見えないまま開いて選べないので、選んだ値が出て一覧が消えるまで待つ
  await expect(box).toContainText(option);
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/**
 * 一覧の上の追加から、名前と一言だけで案を足し、足した案の詳細を開く
 * @param page 開いているページ
 * @param title 案の名前
 * @returns 足した案のサービス ID
 */
export async function addIdea(page: Page, title: string): Promise<string> {
  await page.goto("/services");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "追加", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名前").fill(title);
  await dialog.getByLabel("一言").fill("通しで確かめる案");
  await dialog.getByRole("button", { name: "追加する" }).click();
  await expect(main.getByRole("heading", { level: 2, name: title })).toBeVisible();
  const id = /\/services\/([0-9a-f-]{36})$/.exec(page.url())?.[1];
  if (id === undefined) throw new Error("足した案を開けない");
  return id;
}

/**
 * 段階を移す欄で、理由を選んで移す。選び欄に無い理由は「その他」を選んで書く
 * @param page 開いているページ
 * @param button 移すボタンの文
 * @param reason 理由
 */
export async function move(page: Page, button: string, reason: string): Promise<void> {
  const main = page.getByRole("main");
  await main.getByRole("combobox", { name: "移す理由" }).click();
  const preset = page.getByRole("option", { name: reason, exact: true });
  if ((await preset.count()) > 0) {
    await preset.click();
  } else {
    await page.getByRole("option", { name: "その他", exact: true }).click();
    await main.getByLabel("理由を書く").fill(reason);
  }
  await main.getByRole("button", { name: button }).click();
}

/**
 * 設定の画面で、設計書のリポジトリを選んで保存する。設定は消せないので、前の通しが選んだ物と別の方を選ぶ。useOwnerPasskey を付けたページで呼ぶ
 * @param page 開いているページ
 * @returns 選んだリポジトリ
 */
export async function chooseDocsRepo(page: Page): Promise<string> {
  await page.goto("/settings");
  const docs = page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 2, name: "設計書のリポジトリ", exact: true }) });
  const now = z.object({ data: z.object({ repo: z.string().nullable() }) }).parse(await (await page.request.get("/api/v1/devloop/docs-repo")).json()).data.repo;
  const repo = DOCS_REPOS.find((r) => r !== now) ?? DOCS_REPOS[0];
  await editCard(docs, "設計書のリポジトリ");
  await docs.getByRole("combobox", { name: "設計書のリポジトリ" }).click();
  await page.getByRole("option", { name: repo, exact: true }).click();
  await saveCard(docs, "設計書のリポジトリ", "設計書を置く");
  await expect(docs.getByText(`${repo} を設計書のリポジトリにしました`)).toBeVisible();
  return repo;
}

/**
 * 画面で案を足し、検討を経てリポジトリを選び、試作に進める
 * @param page 開いているページ。useOwnerPasskey を付けておく
 * @param repo 代わりの GitHub が触れるリポジトリ
 * @param title 案の名前
 * @returns 試作に進めたサービスの ID
 */
export async function prototypeService(page: Page, repo: string, title: string): Promise<string> {
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  await chooseDocsRepo(page);
  const id = await addIdea(page, title);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  await choose(page, "リポジトリ", repo);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${repo}、担当: 開発担当`)).toBeVisible();
  return id;
}

/**
 * 設定のタブの、見出しで探した 1 項目のカード
 * @param page 開いているページ
 * @param heading カードの見出し
 * @returns カード
 */
export const settingCard = (page: Page, heading: string) => page.getByRole("main").getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: heading, exact: true }) });
