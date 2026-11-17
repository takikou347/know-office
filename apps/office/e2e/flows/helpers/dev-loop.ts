// 開発の回し方の通しが共有する手伝い。サービスを試作に進めて設計書のリポジトリを選び、タスクの木から題でタスクを探す
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect } from "../../helpers/test.ts";
import { connectGitHub } from "./github.ts";
import { useOwnerPasskey } from "./passkey.ts";
import { freeRepoNames, seedMain } from "./seed.ts";
import { Held } from "./staff-work.ts";
import { addIdea, choose, chooseDocsRepo, move } from "./services.ts";

/** 代わりの GitHub がインストールで選ぶ、サービスのリポジトリ */
export const REPO = "example/know-office";

/**
 * 木の返事から、題が合うタスクの ID を探す
 * @param tree 木の返事
 * @param title 探す題
 * @returns タスク ID。無ければ null
 */
export function findTaskId(tree: unknown, title: string): string | null {
  const pending: unknown[] = [tree];
  const Item = z.object({ id: z.string().optional(), title: z.string().optional() }).loose();
  while (pending.length > 0) {
    const node = pending.pop();
    const list = z.array(z.unknown()).safeParse(node);
    if (list.success) {
      pending.push(...list.data);
      continue;
    }
    const item = Item.safeParse(node);
    if (!item.success) continue;
    if (item.data.title === title && item.data.id !== undefined) return item.data.id;
    pending.push(...Object.values(item.data));
  }
  return null;
}

/**
 * 設計書のリポジトリを選び、案を足して試作に進める。サービスのリポジトリは REPO
 * @param page 開いているページ
 * @param label 案の名前の頭
 * @returns 設計書のリポジトリ、案の名前、サービス ID
 */
export async function prototypeService(page: Page, label = "Issue の案"): Promise<{ docs: string; title: string; serviceId: string }> {
  await useOwnerPasskey(page);
  freeRepoNames();
  await page.goto("/services");
  await connectGitHub(page);
  const docs = await chooseDocsRepo(page);

  const title = `${label} ${crypto.randomUUID().slice(0, 8)}`;
  const serviceId = await addIdea(page, title);
  const main = page.getByRole("main");
  await move(page, "検討に進める", "調べる価値がある");
  await expect(main.getByRole("combobox", { name: "移す先" })).toHaveText(/作ると決める/);
  await choose(page, "移す先", "作ると決める");
  await choose(page, "リポジトリ", REPO);
  await move(page, "作ると決める", "作る");
  await expect(main.getByText(`リポジトリ: ${REPO}、担当: 開発担当`)).toBeVisible();
  return { docs, title, serviceId };
}

/**
 * setAsideBuilderTasks で外したタスクを、待ちのタスクとして開発担当に戻す
 * @param ids 外したタスクの ID を SQL の並びにした物
 */
export function giveBackBuilderTasks(ids: string): void {
  if (ids !== "") seedMain(`UPDATE nodes SET assignee = 'builder', status = 'todo' WHERE id IN (${ids})`);
}

/**
 * 開発担当のまだ済んでいないタスクを開発担当から外す。持っているタスクは見送りにして離させる
 * @param page 画面を開いたページ
 * @returns 外したタスクの ID を SQL の並びにした物。戻す時は、待ちのタスクとして開発担当に戻す
 */
export async function setAsideBuilderTasks(page: Page): Promise<string> {
  const Assigned = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() }).loose()) });
  const Version = z.object({ data: z.object({ version: z.number() }).loose() });
  const aside = new Set<string>();
  const listed = () => [...aside].map((id) => `'${id}'`).join(", ");
  const held = async () => Held.parse(await (await page.request.get("/api/v1/staff")).json()).data.find((s) => s.id === "builder")?.nodeId ?? null;
  // 作業中のタスクは画面から取り消せないので、待ちに戻し、担当を開発担当にしてから取り消す。取り消しが前の担当の社員を離れさせる。
  // 待ちに戻してから取り消すので、Issue を持つタスクでも重なって待つ兄弟を起こさない (起こすのは作業中かレビューの見送りだけ)
  const release = async (id: string) => {
    aside.add(id);
    seedMain(`UPDATE nodes SET status = 'todo', assignee = 'builder' WHERE id = '${id}'`);
    const { version } = Version.parse(await (await page.request.get(`/api/v1/nodes/${id}`)).json()).data;
    expect((await page.request.patch(`/api/v1/nodes/${id}`, { headers: { Origin: new URL(page.url()).origin }, data: { version, status: "dropped" } })).status()).toBe(200);
  };
  try {
    // 外す間にも開発担当は待ちのタスクを取り、呼び出し中の社員は版を進めるので、持つ物も待つ物も無くなるまで読み直す
    await expect(async () => {
      const holding = await held();
      if (holding !== null) await release(holding);
      const all = Assigned.parse(await (await page.request.get("/api/v1/nodes?assignee=builder&limit=100")).json()).data;
      // 上限の 100 件に当たったら取りこぼすので、外し切れないとして落とす
      expect(all.length).toBeLessThan(100);
      for (const n of all.filter((x) => x.status === "doing")) await release(n.id);
      const todo = all.filter((x) => x.status === "todo").map((x) => x.id);
      for (const id of todo) aside.add(id);
      if (todo.length > 0) seedMain(`UPDATE nodes SET assignee = NULL WHERE id IN (${todo.map((id) => `'${id}'`).join(", ")})`);
      expect(await held()).toBeNull();
    }).toPass({ timeout: 60_000 });
  } catch (error) {
    // 離れずに落ちても、外したタスクを後の通しに残さない
    giveBackBuilderTasks(listed());
    throw error;
  }
  return listed();
}
