// 開発の回し方の通し。オーナーが設定の画面で設計書のリポジトリを選び、案を試作に進めると、社員とタスクの画面に開発担当の「設計書: <名前>」のタスクが出る。ゲートウェイの返事は差し替えず、GitHub は開発の代わりの物を使う (開発の回し方の 3.1、3.2)
import { expect, test } from "../helpers/test.ts";
import { connectGitHub, forgetGitHub } from "./helpers/github.ts";
import { useOwnerPasskey } from "./helpers/passkey.ts";
import { freeRepoNames, restoreSeedServices } from "./helpers/seed.ts";
import { addIdea, choose, chooseDocsRepo, move } from "./helpers/services.ts";

/** 代わりの GitHub がインストールで選ぶ、サービスのリポジトリ */
const REPO = "example/know-office";

test.afterEach(() => {
  forgetGitHub();
  restoreSeedServices();
});

test("設計書のリポジトリを選んで試作に進める", async ({ page }) => {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  await chooseDocsRepo(page);

  const title = `設計書の案 ${crypto.randomUUID().slice(0, 8)}`;
  await addIdea(page, title);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる価値がある");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  // サービスのリポジトリは、非公開の設計書のリポジトリとは別の物から選ぶ
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();

  // 開発担当に、設計書のリポジトリへ書くタスクが足されている
  await page.goto("/staff/builder?tab=tasks");
  await expect(page.getByRole("main").getByText(`設計書: ${title}`).first()).toBeVisible();
});
