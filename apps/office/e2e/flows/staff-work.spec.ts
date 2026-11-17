// 社員の仕事の通し。オーナーが目的と組織図の画面でタスクを足して頼み、社員が取り、開発のコンテナの代わりがタスクの開始 (POST /v1/runs) を受け、社員がツールで発言とチェックポイントを伝え、SDK が終えた知らせがゲートウェイに届いてタスクが done になる。ゲートウェイの返事は差し替えず、SDK はゲートウェイの Claude のプロキシを通って手元の代わりの Claude API を呼ぶ (社員が考えるの 3.3)
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { cancelLeftOrders } from "./helpers/seed.ts";
import { part, post } from "./helpers/screen.ts";
import { FAKES } from "../helpers/fakes.ts";
import { CARRY_TITLE, claudeReceived, dropLeftovers, NodeStatus, NodeVersion, PROJECT, Runs, addTask, clockInReviewer, finishedBy, openTree, ownerPasskey, reviewerState, sayToReviewer, scriptFinish, scriptReply, scriptWork } from "./helpers/staff-work.ts";

test("オーナーが画面で頼んだタスクを社員が取り、発言とチェックポイントを伝えて終え、記録に残る", async ({ page }) => {
  // 勤務の時刻を変え、SDK が 3 度呼ぶのを待つ
  test.slow();
  await openTree(page);
  const restore = await clockInReviewer(page);
  try {
    const said = `通しのタスクを読んだ ${String(Date.now())}`;
    await scriptWork(page, said);
    await page.goto("/goals");
    // レビュー担当には見本の todo が無いので、頼んだタスクをすぐ取る
    const title = `通しのタスク ${String(Date.now())}`;
    const nodeId = await addTask(page, title, "レビュー担当");
    await finishedBy(page, nodeId);

    // タスクの木で済になる
    await page.reload();
    await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: `タスク: ${title}` }).last().getByText("済", { exact: true })).toBeVisible();

    // 社員と仕事の画面の会話に、社員の発言が出る
    await page.goto("/staff/reviewer?tab=talk");
    await expect(page.getByRole("log", { name: "レビュー担当との会話" }).getByText(said)).toBeVisible();

    // タスクの詳細の作業の流れに、始めた、チェックポイント、終えたが出る
    await page.goto(`/staff/reviewer/tasks/${nodeId}`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    const flow = part(page, "作業の流れ");
    for (const kind of ["started", "checkpoint", "finished"]) await expect(flow.getByText(kind, { exact: true })).toBeVisible();
  } finally {
    await restore();
  }
});

test.describe("オーナーの発言を社員に渡す", () => {
  test("タスクの途中に話しかけると「社員に渡しました」", async ({ page }) => {
    test.slow();
    await openTree(page);
    const restore = await clockInReviewer(page);
    try {
      // 終わりの返事を 30 秒遅らせ、その間に話しかける。止めた呼び出しの返事は積み直され、続きの呼び出しが受けて終える
      await scriptReply(page, [{ type: "text", text: "通しのタスクを終えた" }], "end_turn", 30_000);
      await page.goto("/goals");
      const nodeId = await addTask(page, `話しかけるタスク ${String(Date.now())}`, "レビュー担当");
      await expect.poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 }).toContainEqual({ staffId: "reviewer", nodeId });
      const said = `途中の話しかけ ${String(Date.now())}`;
      const bubble = await sayToReviewer(page, said);
      await expect(bubble.getByText("社員に渡しました")).toBeVisible({ timeout: 70_000 });
      // 今の呼び出しを止め、発言を指示に続きから呼ぶ
      await expect.poll(() => claudeReceived(page, said), { timeout: 30_000 }).toBe(true);
      await finishedBy(page, nodeId);
      await page.reload();
      await expect(bubble.getByText("社員に渡しました")).toBeVisible();
    } finally {
      await restore();
    }
  });

  test("タスクの外で話しかけて次のタスクを取ると「次のタスクの頭で渡しました」", async ({ page }) => {
    test.slow();
    await openTree(page);
    const restore = await clockInReviewer(page);
    try {
      const said = `タスクの外の話しかけ ${String(Date.now())}`;
      const bubble = await sayToReviewer(page, said);
      await expect(bubble.getByText("次のタスクで渡します")).toBeVisible();
      await scriptFinish(page);
      await page.goto("/goals");
      const nodeId = await addTask(page, `次のタスク ${String(Date.now())}`, "レビュー担当");
      await finishedBy(page, nodeId);
      expect(await claudeReceived(page, said)).toBe(true);
      await page.goto("/staff/reviewer?tab=talk");
      await expect(bubble.getByText("次のタスクの頭で渡しました")).toBeVisible();
    } finally {
      await restore();
    }
  });
});

const Created = z.object({ data: z.object({ id: z.string() }).loose(), meta: z.object({ traceId: z.string() }).loose() }).loose();

test.describe("気付く", () => {
  test("1 本の流れで追う", async ({ page }) => {
    // オーナーが頼んだタスクを社員が取り、ワークスペースが発言して終えるまでを待ち、記録の画面で頼んだ要求をたどる
    test.slow();
    await ownerPasskey(page);
    await openTree(page);
    const restore = await clockInReviewer(page);
    try {
      const said = `流れを追う発言 ${String(Date.now())}`;
      await scriptWork(page, said);
      const title = `流れを追うタスク ${String(Date.now())}`;
      // オーナーの操作をゲートウェイの API に送り、返事の meta から traceId を読む。画面からの足し方は上の通しで確かめる (仮想の認証器を入れたページは、画面の要求の本文を読めない)
      const res = await page.request.post("/api/v1/nodes", {
        headers: { Origin: new URL(page.url()).origin },
        data: { kind: "task", parentId: PROJECT, scope: "office", title, body: "流れを追う", taskKind: "build", assignee: "reviewer", repo: "example/know-office" },
      });
      expect(res.status()).toBe(201);
      const created = Created.parse(await res.json());
      const nodeId = created.data.id;
      const traceId = created.meta.traceId;
      await finishedBy(page, nodeId);

      await page.goto(`/records?trace=${traceId}`);
      const trail = part(page, "要求をたどる");
      await trail.getByRole("button", { name: "パスキーで確かめて記録を開く" }).click();
      const table = trail.getByRole("region", { name: "要求の記録" }).getByRole("table");
      // ゲートウェイ (オーナーが足した)、社員 DO (呼び出しの作業トークンを出した)、ワークスペース (社員の発言) が 1 つの流れに並ぶ
      await expect(table.getByRole("row", { name: new RegExp(`監査ログ.*owner が node\\.create \\(${nodeId}\\)`) })).toBeVisible();
      await expect(table.getByRole("row", { name: /監査ログ.*system が ticket\.issue/ })).toBeVisible();
      await expect(table.getByRole("row", { name: new RegExp(`会話.*reviewer の発言: ${said}`) })).toBeVisible();
    } finally {
      await restore();
    }
  });
});

test("オーナーが画面でタスクを取り消し、頼む先を後から変える", async ({ page }) => {
  await openTree(page);
  const main = page.getByRole("main");

  const dropped = `取り消すタスク ${String(Date.now())}`;
  const droppedId = await addTask(page, dropped, "まだ頼まない");
  // 止めたタスクも取り消せ、取り消した後に止めを再開しても待ちに戻らない
  const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "task", target: droppedId, reason: "取り消す前に止める" } });
  expect(stopped.status()).toBe(201);
  const { stopId } = z.object({ data: z.object({ stopId: z.string() }) }).parse(await stopped.json()).data;
  await page.reload();
  await main.getByRole("button", { name: `${dropped}を変える` }).click();
  await page.getByRole("dialog", { name: `${dropped}を変える` }).getByRole("button", { name: "タスクを取り消す" }).click();
  await expect(page.getByRole("dialog", { name: `${dropped}を変える` })).toBeHidden();
  await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${dropped}` }).last().getByText("見送り")).toBeVisible();
  expect(await post(page, `/api/v1/guard/stops/${stopId}/resume`)).toBe(200);
  expect(NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${droppedId}`)).json()).data.status).toBe("dropped");

  // 頼む先の無いタスクは誰も取らず、頼む先を付けるとその社員が取る
  const later = `後から頼むタスク ${String(Date.now())}`;
  const nodeId = await addTask(page, later, "まだ頼まない");
  await scriptFinish(page);
  await main.getByRole("button", { name: `${later}を変える` }).click();
  const dialog = page.getByRole("dialog", { name: `${later}を変える` });
  await dialog.getByRole("radiogroup", { name: "頼む先" }).getByRole("radio", { name: "レビュー担当" }).click();
  await dialog.getByRole("button", { name: "頼む先を変える" }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${later}` }).last().getByText("頼む先: レビュー担当")).toBeVisible();
  await finishedBy(page, nodeId);
});

test("ほかで先に頼む先が変わっていたら、木の上に知らせて今の頼む先を出す", async ({ page }) => {
  await openTree(page);
  const main = page.getByRole("main");
  const title = `先に変わるタスク ${String(Date.now())}`;
  const nodeId = await addTask(page, title, "まだ頼まない");
  // 直に頼む先をレビュー担当に変えると、レビュー担当が取って終える
  await scriptFinish(page);
  await main.getByRole("button", { name: `${title}を変える` }).click();
  const dialog = page.getByRole("dialog", { name: `${title}を変える` });
  await dialog.getByRole("radiogroup", { name: "頼む先" }).getByRole("radio", { name: "社長" }).click();
  // 画面が読んだ後に、ゲートウェイへ直に頼む先を変えて版を進める
  const { version } = NodeVersion.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data;
  const moved = await page.request.patch(`/api/v1/nodes/${nodeId}`, { headers: { Origin: new URL(page.url()).origin }, data: { version, assignee: "reviewer" } });
  expect(moved.status()).toBe(200);
  await dialog.getByRole("button", { name: "頼む先を変える" }).click();
  await expect(main.getByText("ほかで先に変わっていたので読み直しました")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole("listitem").filter({ hasText: `タスク: ${title}` }).last().getByText("頼む先: レビュー担当")).toBeVisible();
  await finishedBy(page, nodeId);
});

/**
 * 日本時間の今から 2 分後の「HH:MM」と、その時刻を返す。早退の指示は今より後の分にしか出せない
 * @returns 時刻の文字と協定世界時のミリ秒
 */
function soon(): { hhmm: string; at: number } {
  const jst = new Date(Date.now() + 9 * 60 * 60_000 + 2 * 60_000);
  jst.setUTCSeconds(0, 0);
  const hhmm = `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
  return { hhmm, at: jst.getTime() - 9 * 60 * 60_000 };
}

test("早退の指示で退勤した社員のタスクは待ちに戻り、出勤し直すと同じ社員が先に取って進める", async ({ page }) => {
  // 早退の時刻を本物の時計で待つ
  test.setTimeout(360_000);
  const until = soon();
  // 勤務の時刻を 23:59 までに広げるので、早退はそれより前でないと出せない
  test.skip(until.hhmm >= "23:58" || until.hhmm < "00:03", "日をまたぐ時刻は早退を出せない");
  await openTree(page);
  cancelLeftOrders("reviewer");
  await dropLeftovers(page);
  const restore = await clockInReviewer(page, true);
  try {
    // 早退の時刻を過ぎてから、SDK がチェックポイントを伝える。それまで社員はタスクの途中にいる
    const checkpoint = { type: "tool_use", id: "toolu_flow_carry", name: "mcp__staff__checkpoint", input: { kind: "note", note: "続きは明日" } };
    await scriptReply(page, [checkpoint], "tool_use", until.at - Date.now() + 15_000);
    // チェックポイントで退勤した後も SDK はその次を求めるので、終わりの文で閉じさせる。社員はもうタスクを離れているので、この終わりはタスクを済にしない
    await scriptReply(page, [{ type: "text", text: "今日はここまで" }], "end_turn");
    await page.goto("/goals");
    const title = `${CARRY_TITLE} ${String(Date.now())}`;
    const nodeId = await addTask(page, title, "レビュー担当");
    await expect.poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()), { timeout: 30_000 }).toContainEqual({ staffId: "reviewer", nodeId });

    // 社員と仕事の画面のボタンで早退を出す
    await page.goto("/staff/reviewer");
    await page.getByRole("radiogroup", { name: "今日だけの指示" }).getByRole("radio", { name: "早退" }).click();
    await page.getByLabel("終わりの時刻").fill(until.hhmm);
    await page.getByRole("button", { name: "指示を出す" }).click();
    await expect(page.getByText(`レビュー担当に今日の早退を ${until.hhmm} までで出しました`)).toBeVisible();

    // 早退の時刻を過ぎてチェックポイントに届くと退勤し、タスクは待ちに戻る
    await expect.poll(() => reviewerState(page), { timeout: until.at - Date.now() + 90_000 }).toBe("off");
    await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("todo");
    await page.goto(`/staff/reviewer/tasks/${nodeId}`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByRole("main").getByText("次", { exact: true }).first()).toBeVisible();
    await expect(part(page, "作業の流れ").getByText("continued", { exact: true })).toBeVisible();

    // 早退を取り消し、出勤し直すと、同じ社員が続けたタスクを先に取って呼び直す。開発の代わりのワークスペースは会話の記録を送らないので、続きからでなく最初から呼ぶ
    await page.goto("/staff/reviewer");
    const active = page.getByRole("list", { name: "レビュー担当への今日の指示" }).getByRole("listitem").filter({ hasText: "に出した" });
    await active.getByRole("button", { name: "早退の指示を取り消す" }).click();
    await expect(page.getByText("早退の指示を取り消しました")).toBeVisible();
    // 出勤し直すとすぐ取って SDK が呼ぶので、終わりの返事は出勤させる前に積む。前の呼び出しは閉じたので、ほかに取られない
    await scriptFinish(page);
    expect((await page.request.post("/__dev/staff/reviewer/forget-day")).status()).toBe(204);
    await expect.poll(async () => Runs.parse(await (await page.request.get(`${FAKES}/workspace/__fake/runs`)).json()).filter((r) => r.staffId === "reviewer" && r.nodeId === nodeId), { timeout: 30_000 }).toHaveLength(2);
    await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status, { timeout: 60_000 }).toBe("done");
    // 呼び直しが返事の無い代わりの Claude API に当たって、ワークスペースを待つ事になっていない
    expect(await reviewerState(page)).not.toBe("waiting");
  } finally {
    // 途中で落ちても、広げた勤務の時刻、早退の指示、続けるタスクを次の通しに残さない。片付けは落ちうるので、勤務の時刻を先に戻す
    try {
      await restore();
    } finally {
      cancelLeftOrders("reviewer");
      await dropLeftovers(page);
    }
  }
});
