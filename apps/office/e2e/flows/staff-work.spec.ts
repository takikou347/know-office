// 社員の仕事の通し。オーナーが目標の画面でタスクを足して頼み、社員が取り、開発のコンテナの代わりがタスクの開始 (POST /v1/runs) を受け、社員がツールで発言とチェックポイントを伝え、SDK が終えた知らせがゲートウェイに届いてタスクが done になる。ゲートウェイの返事は差し替えず、SDK はゲートウェイの Claude のプロキシを通って手元の代わりの Claude API を呼ぶ (社員が考えるの 3.3)
import { z } from "zod";
import { expect, test } from "../helpers/test.ts";
import { cancelLeftOrders } from "./helpers/seed.ts";
import { part, post } from "./helpers/screen.ts";
import { FAKES } from "../helpers/fakes.ts";
import { clockIn, ownerPasskey, scriptReply, staffState } from "./helpers/staff.ts";
import { CARRY_TITLE, claudeReceived, column, dropLeftovers, NodeStatus, NodeVersion, PROJECT, Runs, Trees, addTask, finishedBy, openTree, pick, sayToReviewer, scriptFinish, scriptWork, taskCard } from "./helpers/staff-work.ts";

test.describe("タスクの繰り返し", () => {
  test("タスクの流れ", async ({ page }) => {
    // オーナーが画面で頼んだタスクを社員が取り、発言とチェックポイントを伝えて終え、記録に残る
    // 勤務の時刻を変え、SDK が 3 度呼ぶのを待つ
    test.slow();
    await openTree(page);
    const restore = await clockIn(page, "reviewer");
    try {
      const said = `通しのタスクを読んだ ${String(Date.now())}`;
      await scriptWork(page, said);
      await page.goto("/goals");
      // レビュー担当には見本の todo が無いので、頼んだタスクをすぐ取る
      const title = `通しのタスク ${String(Date.now())}`;
      const nodeId = await addTask(page, title, "レビュー担当");
      await finishedBy(page, nodeId);

      // 目標の画面で完了の列に出る
      await page.reload();
      await expect(taskCard(page, title, column(page, "完了"))).toBeVisible();

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
});

test.describe("オーナーの発言を渡す", () => {
  test("タスク中に話しかける", async ({ page }) => {
    // タスクの途中に話しかけると「社員に渡しました」と出る
    test.slow();
    await openTree(page);
    const restore = await clockIn(page, "reviewer");
    try {
      // 終わりの返事を 30 秒遅らせ、その間に話しかける。止めた呼び出しの返事は積み直され、続きの呼び出しが受けて終える
      await scriptReply(page, "reviewer", [{ type: "text", text: "通しのタスクを終えた" }], "end_turn", 30_000);
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

  test("タスクの外で話しかけて次のタスクで渡す", async ({ page }) => {
    // タスクの外で話しかけて次のタスクを取ると「次のタスクの頭で渡しました」と出る
    test.slow();
    await openTree(page);
    const restore = await clockIn(page, "reviewer");
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
    const restore = await clockIn(page, "reviewer");
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

test.describe("目的からタスクまでの木", () => {
  test("止めたタスクを取り消すと見送りになり、止めを再開しても待ちに戻らない", async ({ page }) => {
    await openTree(page);
    const main = page.getByRole("main");
    const dropped = `取り消すタスク ${String(Date.now())}`;
    const droppedId = await addTask(page, dropped, "まだ頼まない");
    const stopped = await page.request.post("/api/v1/guard/stops", { headers: { Origin: new URL(page.url()).origin }, data: { scope: "task", target: droppedId, reason: "取り消す前に止める" } });
    expect(stopped.status()).toBe(201);
    const { stopId } = z.object({ data: z.object({ stopId: z.string() }) }).parse(await stopped.json()).data;
    await page.reload();
    // 止めたタスクは未着手の列に停止中の印で出る
    await expect(taskCard(page, dropped, column(page, "未着手")).getByText("停止中")).toBeVisible();
    await main.getByRole("button", { name: `${dropped}を変える` }).click();
    await page.getByRole("dialog", { name: `${dropped}を変える` }).getByRole("button", { name: "取り消す", exact: true }).click();
    await expect(page.getByRole("dialog", { name: `${dropped}を変える` })).toBeHidden();
    // 取り消したタスクは列から消える
    await expect(taskCard(page, dropped)).toHaveCount(0);
    expect(await post(page, `/api/v1/guard/stops/${stopId}/resume`)).toBe(200);
    expect(NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${droppedId}`)).json()).data.status).toBe("dropped");
  });

  test("オーナーが画面でタスクを足し、後から頼む先を付けるとその社員が取る", async ({ page }) => {
    await openTree(page);
    const main = page.getByRole("main");
    // 頼む先の無いタスクは誰も取らず、頼む先を付けるとその社員が取る
    const later = `後から頼むタスク ${String(Date.now())}`;
    const nodeId = await addTask(page, later, "まだ頼まない");
    await scriptFinish(page);
    await main.getByRole("button", { name: `${later}を変える` }).click();
    const dialog = page.getByRole("dialog", { name: `${later}を変える` });
    await pick(dialog, page, "頼む先", "レビュー担当");
    await dialog.getByRole("button", { name: "保存する" }).click();
    await expect(dialog).toBeHidden();
    await expect(taskCard(page, later).getByText("レビュー担当", { exact: true })).toBeVisible();
    await finishedBy(page, nodeId);
  });

  test("オーナーが画面で目標を期限付きで足し、その下にタスクを足すと未着手の列に出る", async ({ page }) => {
    // データの無い所から、オーナーが画面だけで目的、目標、プロジェクト、タスクを置ける。通しごとに違う題にし、前の通しの木と混ぜない
    const mark = String(Date.now());
    const purpose = `目的を置く ${mark}`;
    const goal = `目標を置く ${mark}`;
    const task = `置いた目標のタスク ${mark}`;
    await page.goto("/goals");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "目標を足す" }).click();
    const adding = page.getByRole("dialog", { name: "目標を足す" });
    await adding.getByRole("textbox", { name: "目標" }).fill(goal);
    await pick(adding, page, "目的", "新しい目的");
    await adding.getByRole("textbox", { name: "目的の名前" }).fill(purpose);
    await adding.getByRole("button", { name: /^期限、/ }).click();
    await page.getByRole("button", { name: /、今日/ }).click();
    await adding.getByRole("button", { name: "足す", exact: true }).click();
    await expect(adding).toBeHidden();

    // 足した目標が開き、期限の印と空の 4 列が出る
    await expect(main.getByRole("heading", { level: 2, name: goal })).toBeVisible();
    await expect(part(page, goal).getByText(/^期限 \d+\/\d+$/)).toBeVisible();
    for (const label of ["未着手", "進行中", "レビュー", "完了"]) await expect(column(page, label).getByText("データがありません")).toBeVisible();

    // プロジェクトの無い目標には、目標の名前のプロジェクトを作ってタスクを足す
    await part(page, goal).getByRole("button", { name: "タスクを足す" }).click();
    const dialog = page.getByRole("dialog", { name: `「${goal}」にタスクを足す` });
    await expect(dialog.getByRole("textbox", { name: "プロジェクトの名前" })).toHaveValue(goal);
    await dialog.getByRole("textbox", { name: "題" }).fill(task);
    await dialog.getByRole("button", { name: "足す", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(taskCard(page, task, column(page, "未着手")).getByText("まだ頼まない")).toBeVisible();

    // 目標の一覧に、目的と進み具合のカードで出る
    await page.goto("/goals");
    await pick(main, page, "目的で絞る", purpose);
    const card = main.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: goal }) });
    await expect(card.getByText(`目的: ${purpose}`)).toBeVisible();
    await expect(card.getByText("タスク 1 件のうち 0 件が完了")).toBeVisible();

    // 木は目的、目標、プロジェクト、タスクの順に親をたどれる
    const trees = Trees.parse(await (await page.request.get("/api/v1/nodes?scope=office&limit=100")).json()).data;
    const root = trees.find((t) => t.title === purpose);
    expect(root?.children.map((g) => g.title)).toEqual([goal]);
    expect(root?.children[0]?.children.map((p) => p.title)).toEqual([goal]);
    expect(root?.children[0]?.children[0]?.children.map((t) => t.title)).toEqual([task]);

    // 後の通しの社員が取らないよう、足したタスクを取り消す
    await card.getByRole("link", { name: goal }).click();
    await main.getByRole("button", { name: `${task}を変える` }).click();
    await page.getByRole("dialog", { name: `${task}を変える` }).getByRole("button", { name: "取り消す", exact: true }).click();
    await expect(taskCard(page, task)).toHaveCount(0);
  });

  test("ほかで先に頼む先が変わっていたら、目標の上に知らせて今の頼む先を出す", async ({ page }) => {
    await openTree(page);
    const main = page.getByRole("main");
    const title = `先に変わるタスク ${String(Date.now())}`;
    const nodeId = await addTask(page, title, "まだ頼まない");
    // 直に頼む先をレビュー担当に変えると、レビュー担当が取って終える
    await scriptFinish(page);
    await main.getByRole("button", { name: `${title}を変える` }).click();
    const dialog = page.getByRole("dialog", { name: `${title}を変える` });
    await pick(dialog, page, "頼む先", "社長");
    // 画面が読んだ後に、ゲートウェイへ直に頼む先を変えて版を進める
    const { version } = NodeVersion.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data;
    const moved = await page.request.patch(`/api/v1/nodes/${nodeId}`, { headers: { Origin: new URL(page.url()).origin }, data: { version, assignee: "reviewer" } });
    expect(moved.status()).toBe(200);
    await dialog.getByRole("button", { name: "保存する" }).click();
    await expect(main.getByText("ほかで先に変わっていたので読み直しました")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(taskCard(page, title).getByText("レビュー担当", { exact: true })).toBeVisible();
    await finishedBy(page, nodeId);
  });
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
  // 22 時より後は通しの勤務の時刻が日をまたぐ形になり、早退を出せない。0 時の直後は今日の勤務の始まりが早退の時刻に近い
  test.skip(until.hhmm >= "21:55" || until.hhmm < "00:03", "日をまたぐ勤務の時刻には早退を出せない");
  await openTree(page);
  cancelLeftOrders("reviewer");
  await dropLeftovers(page);
  const restore = await clockIn(page, "reviewer", true);
  try {
    // 早退の時刻を過ぎてから、SDK がチェックポイントを伝える。それまで社員はタスクの途中にいる
    const checkpoint = { type: "tool_use", id: "toolu_flow_carry", name: "mcp__staff__checkpoint", input: { kind: "note", note: "続きは明日" } };
    await scriptReply(page, "reviewer", [checkpoint], "tool_use", until.at - Date.now() + 15_000);
    // チェックポイントで退勤した後も SDK はその次を求めるので、終わりの文で閉じさせる。社員はもうタスクを離れているので、この終わりはタスクを済にしない
    await scriptReply(page, "reviewer", [{ type: "text", text: "今日はここまで" }], "end_turn");
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
    await expect.poll(() => staffState(page, "reviewer"), { timeout: until.at - Date.now() + 90_000 }).toBe("off");
    await expect.poll(async () => NodeStatus.parse(await (await page.request.get(`/api/v1/nodes/${nodeId}`)).json()).data.status).toBe("todo");
    await page.goto(`/staff/reviewer/tasks/${nodeId}`);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByRole("main").getByText("未着手", { exact: true }).first()).toBeVisible();
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
    expect(await staffState(page, "reviewer")).not.toBe("waiting");
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
