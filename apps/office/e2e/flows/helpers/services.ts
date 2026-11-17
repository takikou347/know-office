// アイデアとサービスの画面の通しで使う、画面の操作。案を足し、段階を移し、設計書のリポジトリを選ぶ
import type { Page } from "@playwright/test";
import { expect } from "../../helpers/test.ts";
import { z } from "zod";

/** 代わりの GitHub が初めから入れる非公開のリポジトリ 2 つ。設計書のリポジトリに交互に選ぶ */
const DOCS_REPOS = ["example/knowidea-docs", "example/other-docs"] as const;

/**
 * Knowidea-ui の選ぶ欄で 1 つ選ぶ
 * @param page 開いているページ
 * @param label 欄の名前
 * @param option 選ぶ物
 */
export async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("main").getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/**
 * 画面の案を足す欄で案を足し、足した案の詳細を開く
 * @param page 開いているページ
 * @param title 案の名前
 * @returns 足した案のサービス ID
 */
export async function addIdea(page: Page, title: string): Promise<string> {
  await page.goto("/services");
  const main = page.getByRole("main");
  await main.getByLabel("案の名前").fill(title);
  await choose(page, "種類", "Web アプリ");
  await main.getByLabel("狙い").fill("通しで確かめる案");
  await main.getByLabel("使う人").fill("オーナー");
  await main.getByLabel("月の費用の見込み (ドル)").fill("3.5");
  await main.getByRole("button", { name: "案を足す" }).click();
  await expect(main.getByRole("heading", { level: 2, name: title })).toBeVisible();
  const id = /\/services\/([0-9a-f-]{36})$/.exec(page.url())?.[1];
  if (id === undefined) throw new Error("足した案を開けない");
  return id;
}

/**
 * 段階を移す欄で、理由を書いて移す
 * @param page 開いているページ
 * @param button 移すボタンの文
 * @param reason 理由
 */
export async function move(page: Page, button: string, reason: string): Promise<void> {
  const main = page.getByRole("main");
  await main.getByLabel("移す理由").fill(reason);
  await main.getByRole("button", { name: button }).click();
}

/**
 * 設定の画面で、設計書のリポジトリを選んで保存する。設定は消せないので、前の通しが選んだ物と別の方を選ぶ。useOwnerPasskey を付けたページで呼ぶ
 * @param page 開いているページ
 * @returns 選んだリポジトリ
 */
export async function chooseDocsRepo(page: Page): Promise<string> {
  await page.goto("/settings");
  const docs = page.getByRole("main").locator("section", { has: page.getByRole("heading", { level: 2, name: "設計書のリポジトリ", exact: true }) });
  const now = z.object({ data: z.object({ repo: z.string().nullable() }) }).parse(await (await page.request.get("/api/v1/devloop/docs-repo")).json()).data.repo;
  const repo = DOCS_REPOS.find((r) => r !== now) ?? DOCS_REPOS[0];
  await docs.getByRole("combobox", { name: "設計書のリポジトリ" }).click();
  await page.getByRole("option", { name: repo, exact: true }).click();
  await docs.getByLabel("選ぶ理由").fill("設計書を置く");
  await docs.getByRole("button", { name: "設計書のリポジトリを保存する" }).click();
  await expect(docs.getByText(`${repo} を設計書のリポジトリにしました`)).toBeVisible();
  return repo;
}
