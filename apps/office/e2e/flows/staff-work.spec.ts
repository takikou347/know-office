// 社員の仕事の始まりの通し。オーナーが頼んだタスクを社員が取り、開発のコンテナの代わりがタスクの開始 (POST /v1/runs) を受ける。ゲートウェイの返事は差し替えず、SDK は手元の代わりの Claude API だけを呼ぶ (社員が考えるの 3.2)
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { seedMain } from "./helpers/seed.ts";
import { post } from "./helpers/screen.ts";

/** 代わりの物の置き場。.dev.vars.example の DEV_FAKES_URL と同じ番号 */
const FAKES = "http://127.0.0.1:5199";

/** 通しの置き場の木。目的と組織図の画面の見本の木と分け、見本の進み具合を変えない */
const PURPOSE = "019a7b00-0000-7000-8000-0000000000e1";
const GOAL = "019a7b00-0000-7000-8000-0000000000e2";
const PROJECT = "019a7b00-0000-7000-8000-0000000000e3";

const Created = z.object({ data: z.object({ id: z.uuid() }).loose() });
const NodeStatus = z.object({ data: z.object({ status: z.string() }).loose() });
const Runs = z.array(z.object({ staffId: z.string(), nodeId: z.string() }));
const State = z.object({ data: z.object({ stopped: z.array(z.object({ scope: z.string(), stopId: z.string() })) }) });
const StopMade = z.object({ data: z.object({ stopId: z.uuid() }) });

/**
 * 前の通しが止めたままにした社員を再開する。止まった社員はタスクを取らない
 * @param page 画面を開いたページ
 */
async function resumeStaff(page: Page): Promise<void> {
  const state = State.parse(await (await page.request.get("/api/v1/guard/state")).json());
  for (const s of state.data.stopped.filter((x) => x.scope === "staff")) expect(await post(page, `/api/v1/guard/stops/${s.stopId}/resume`)).toBe(200);
}

/**
 * 社員が持ったタスクを、手で止めて社員から離し、再開して記録を閉じ、見送りにする。代わりのワークスペースはゲートウェイに終わりを送らないので、社員が持ったままになるのを片付ける
 * @param page 画面を開いたページ
 * @param nodeId タスク ID
 */
async function release(page: Page, nodeId: string): Promise<void> {
  const headers = { Origin: new URL(page.url()).origin };
  const made = await page.request.post("/api/v1/guard/stops", { headers, data: { scope: "task", target: nodeId, reason: "通しの片付け" } });
  expect(made.status()).toBe(201);
  const { stopId } = StopMade.parse(await made.json()).data;
  expect(await post(page, `/api/v1/guard/stops/${stopId}/resume`)).toBe(200);
  // 再開でタスクは todo に戻るので、社員が取る前に見送りにする
  seedMain(`UPDATE nodes SET status = 'dropped', version = version + 1 WHERE id = '${nodeId}' AND status = 'todo'`);
}

test("オーナーが頼んだタスクを社員が取り、ワークスペースがタスクの開始を受ける", async ({ page }) => {
  seedMain(
    "INSERT OR IGNORE INTO nodes (id, kind, parent_id, scope, title, body, task_kind, assignee, status, priority, created_by, created_at, updated_at) VALUES " +
      `('${PURPOSE}', 'purpose', NULL, 'office', '社員の仕事の通し', NULL, NULL, NULL, 'todo', 900, 'owner', 1794528000000, 1794528000000), ` +
      `('${GOAL}', 'goal', '${PURPOSE}', 'office', '社員がタスクを始める', NULL, NULL, NULL, 'todo', 900, 'owner', 1794528000000, 1794528000000), ` +
      `('${PROJECT}', 'project', '${GOAL}', 'office', '通しのタスク', NULL, NULL, NULL, 'todo', 900, 'owner', 1794528000000, 1794528000000)`,
  );
  await page.goto("/goals");
  await expect(page.getByRole("heading", { level: 2, name: "目的: 社員の仕事の通し" })).toBeVisible();
  await resumeStaff(page);

  // レビュー担当には見本の todo が無いので、頼んだタスクをすぐ取る。勤務時間外なら呼び出して取る
  const title = `通しのタスク ${String(Date.now())}`;
  const res = await page.request.post("/api/v1/nodes", {
    headers: { Origin: new URL(page.url()).origin },
    data: { kind: "task", parentId: PROJECT, scope: "office", title, taskKind: "build", assignee: "reviewer", priority: 0 },
  });
  expect(res.status()).toBe(201);
  const nodeId = Created.parse(await res.json()).data.id;
  try {
    await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("doing");
    await page.reload();
    await expect(page.getByText(`タスク: ${title}`)).toBeVisible();
    // 社員 DO は取った後に鎖の外で呼び出しを始め、開発のコンテナの代わりが /v1/runs を受ける
    await expect
      .poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 })
      .toContainEqual({ staffId: "reviewer", nodeId });
  } finally {
    await release(page, nodeId);
  }
});
