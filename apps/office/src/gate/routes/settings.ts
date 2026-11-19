// 設定: office の設定とサービスの初期値、サービスごとの設定 (API の settings、サービスと拡張の 3.3)
import { createRoute, z } from "@hono/zod-openapi";
import { INHERITED_KEYS, Setting, StaffId, UpdateSettingInput } from "@know-office/core";
import { createRouter } from "../app.ts";
import { requireStepUp } from "../auth/passkey.ts";
import { MERGE_WHEN_KEY, protectRepos } from "../github/rules.ts";
import { loadThresholds } from "../guard/thresholds.ts";
import { recordError } from "../ledger/errors.ts";
import { audit } from "../ledger/record.ts";
import { listQuery, listResponse, okResponse, problems } from "../openapi.ts";
import { list, ok } from "../respond.ts";
import {
  DEFAULT_PREFIX,
  loadOfficeDefaults,
  loadScheduleSetting,
  loadServiceSettings,
  SCHEDULE_KEY,
  updateOfficeDefault,
  updateSchedule,
  updateServiceSetting,
} from "../services/settings.ts";
import { chooseRepo } from "../services/repo.ts";
import { COST_SWITCHES, loadSwitch, updateSwitch } from "../services/switches.ts";
import { staffDo } from "../work/loop.ts";

const router = createRouter();

const jsonBody = <T>(schema: T) => ({ content: { "application/json": { schema } }, required: true });
const ServiceParam = z.object({ serviceId: z.uuid().openapi({ param: { name: "serviceId", in: "path" }, description: "UUID v7" }) }).strict();
const KeyParam = z.object({ key: z.string().openapi({ param: { name: "key", in: "path" } }) }).strict();

const listServiceSettingsRoute = createRoute({
  method: "get",
  path: "/api/v1/services/{serviceId}/settings",
  operationId: "listServiceSettings",
  tags: ["settings"],
  summary: "サービスの設定",
  description: "初期値を引き継いでいるかを inherited で返す。項目はリポジトリ (`repo`)、担当の社員 (`staffId`)、できる操作 (`actions`)、main にマージする条件 (`mergeWhen`)、本番にデプロイする条件 (`deployWhen`)、触れない所 (`protectedPaths`)、このサービスだけを止める (`paused`) の順。",
  "x-steps": [
    "サービスを取得する",
    "最新の `service_settings` と office の初期値 (`settings` の `service.<項目>`) から、適用される値を組み立てる。リポジトリと担当の社員は初期値を持たず、`services` の行の値を使う",
  ],
  "x-errors": ["404 `not_found`: サービスが存在しない"],
  request: { params: ServiceParam, query: listQuery(router) },
  responses: { 200: listResponse(Setting), ...problems(400, 401, 403, 404, 422, 429, 500) },
});

const updateServiceSettingRoute = createRoute({
  method: "put",
  path: "/api/v1/services/{serviceId}/settings/{key}",
  operationId: "updateServiceSetting",
  tags: ["settings"],
  summary: "サービスの設定を変更する",
  description: "守りを弱める変更の場合のみ、15 分以内のパスキーの確認が必要。ルールの判断は受け継いだ値をそのたびに組み立てて使うので、変えた値は次の判断から効く。",
  "x-steps": [
    "サービスを取得し、`key` がサービスの設定項目かを確認し、キーごとの Zod スキーマで値を検証する。`null` は初期値を持つ項目だけに使える",
    "`version` が現在と一致することを確認する",
    "`key` が `repo` の時は、GitHub と連携していて、GitHub App のインストールで選んだリポジトリの中にある事を確かめる",
    "今の実効値と変えた後の実効値 (`null` は受け継いだ後の値) を比べ、守りを弱める変更 (できる操作に今の値に無い操作を足す、main にマージする条件か本番にデプロイする条件から条件を外す、触れない所から道を外す、止めたサービスを動かす) ならパスキーの確認を求める",
    "`service_settings` に追加し、監査ログに `service.setting` を記録する。担当の社員かリポジトリを変える時は `services.staff_id` か `services.repo` も同じバッチで直す。リポジトリは確かめた時の連携のままの時だけ書く",
    "`key` が `mergeWhen` の時は、そのサービスのリポジトリが公開なら、ルールセット「know-office」を新しい条件で設定し直す",
  ],
  "x-errors": [
    "404 `not_found`: サービスが存在しない、または設定項目が存在しない",
    "401 `step_up_required`: 守りを弱める変更で、パスキーの確認がない",
    "409 `conflict`: バージョンが異なる、初期値に戻す間に office の初期値が変わった、GitHub と連携していないのにリポジトリを変える、または確かめた後に連携が変わった",
    "422 `validation_failed`: 値が項目の形に合わない、初期値を持たない項目に `null` を送った、またはリポジトリが触れるリポジトリに無い",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した。変えた設定と監査ログは残る",
  ],
  "x-step-up": "conditional",
  request: { params: ServiceParam.extend(KeyParam.shape), body: jsonBody(UpdateSettingInput) },
  responses: { 200: okResponse(Setting), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
});

const listSettingsRoute = createRoute({
  method: "get",
  path: "/api/v1/settings",
  operationId: "listSettings",
  tags: ["settings"],
  summary: "office の設定とサービスの初期値",
  description: "キーは勤務の時刻 (`workday.schedule`)、時間外の呼び出し (`workday.offHoursCall`)、会話の言葉の指示 (`workday.chatOrders`)、レビュー担当に止めた記録を聞く事 (`guard.review`)、自動停止の基準 (`guard.thresholds`)、サービスの初期値 (`service.actions`、`service.mergeWhen`、`service.deployWhen`、`service.protectedPaths`、`service.paused`) の順。行が無い項目は組み込みの初期値をバージョン 0 で返し、inherited を true にする。",
  "x-steps": ["`settings` からキーごとの最新の値を取得する"],
  request: { query: listQuery(router) },
  responses: { 200: listResponse(Setting), ...problems(400, 401, 403, 422, 429, 500) },
});

const updateSettingRoute = createRoute({
  method: "put",
  path: "/api/v1/settings/{key}",
  operationId: "updateSetting",
  tags: ["settings"],
  summary: "office の設定を変更する",
  description: "守りを弱める変更、勤務を延ばす変更、時間外の呼び出しか会話の言葉の指示かレビュー担当に聞く事を開くか回数を増やす変更の場合のみ、15 分以内のパスキーの確認が必要。",
  "x-steps": [
    "`key` がこのルートで変えられる項目 (サービスの初期値の `service.<項目>`、勤務の時刻の `workday.schedule`、時間外の呼び出しの `workday.offHoursCall`、会話の言葉の指示の `workday.chatOrders`、レビュー担当に止めた記録を聞く事の `guard.review`) かを確認し、キーごとの Zod スキーマで値を検証する。勤務の時刻は始まりと終わりが違い、曜日が 1 つ以上で重ならない事も確かめる。`guard.thresholds` と `github.rules` は専用のルートで変更する",
    "`version` が現在と一致することを確認する",
    "今の初期値と変えた後の値を比べ、守りを弱める変更 (できる操作に今の値に無い操作を足す、main にマージする条件か本番にデプロイする条件から条件を外す、触れない所から道を外す、止めたサービスを動かす) ならパスキーの確認を求める。勤務の時刻は、今の勤務の時間に無い時間を足す変更 (終わりを遅らせる、始まりを早める、曜日を足す) ならパスキーの確認を求める。時間外の呼び出しと会話の言葉の指示とレビュー担当に聞く事は、開く変更と回数を増やす変更ならパスキーの確認を求める",
    "`settings` に範囲 `office` で、読んだ版より新しい行が無い時だけ追加し、監査ログに `setting.update` を記録する",
    "`key` が `service.mergeWhen` の時は、サービスのリポジトリと触れるリポジトリのうち公開のリポジトリに、ルールセット「know-office」を新しい条件で設定し直す。`workday.schedule` の時は、3 人の `StaffDO` の alarm を新しい時刻で掛け直す。掛け直せなかった社員は変更を残したまま `error_events` に `schedule_rearm_failed` で残す",
  ],
  "x-errors": [
    "404 `not_found`: 設定項目が存在しない、または`guard.thresholds` と `github.rules` は専用のルートで変更するため、このルートでは扱えない",
    "401 `step_up_required`: 守りを弱める変更、勤務を延ばす変更、時間外の呼び出しか会話の言葉の指示かレビュー担当に聞く事を開くか回数を増やす変更で、パスキーの確認がない",
    "409 `conflict`: バージョンが異なる",
    "422 `validation_failed`: 値が項目の形に合わない、または `null` を送った",
    "429 `rate_limited`: GitHub の上限に当たった。待つ秒を `Retry-After` に付ける",
    "502 `upstream_failed`: GitHub がエラーを返した。変えた設定と監査ログは残る",
  ],
  "x-step-up": "conditional",
  request: { params: KeyParam, body: jsonBody(UpdateSettingInput) },
  responses: { 200: okResponse(Setting), ...problems(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 502) },
});

/**
 * 項目の決まった並びを、キーをカーソルにして 1 ページに切る
 * @param items 決まった順の項目
 * @param page カーソルと件数
 * @param page.cursor 前のページの最後のキー
 * @param page.limit 件数
 * @returns 1 ページと次のカーソル
 */
function pageOf(items: Setting[], page: { cursor?: string | undefined; limit: number }): { items: Setting[]; next: string | null } {
  const start = page.cursor === undefined ? 0 : items.findIndex((s) => s.key === page.cursor) + 1;
  // 知らないカーソルは並びの外なので、続きを返さない
  const from = page.cursor !== undefined && start === 0 ? items.length : start;
  const slice = items.slice(from, from + page.limit);
  return { items: slice, next: from + page.limit < items.length ? (slice.at(-1)?.key ?? null) : null };
}

/** 設定のルート */
export const settingRoutes = router
  .openapi(listServiceSettingsRoute, async (c) => {
    const all = await loadServiceSettings(c.env.DB, c.req.valid("param").serviceId);
    const { items, next } = pageOf(all, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(updateServiceSettingRoute, async (c) => {
    const { serviceId, key } = c.req.valid("param");
    const { version, value, reason } = c.req.valid("json");
    const setting = await updateServiceSetting(
      c.env.DB,
      { serviceId, key, value, version, now: c.var.clock.now() },
      () => requireStepUp(c),
      (repo) => chooseRepo(c.env, c.var.github, repo, "#/value"),
    );
    await audit(c, "service.setting", serviceId, { key, value, version: setting.version, reason });
    // 変えた設定と記録を残してから、公開のリポジトリのルールセットを掛け直す
    if (key === "mergeWhen") await protectRepos(c.env, c.var.forge, serviceId);
    return ok(c, setting);
  })
  .openapi(listSettingsRoute, async (c) => {
    const db = c.env.DB;
    const [schedule, switches, thresholds, defaults] = await Promise.all([loadScheduleSetting(db), Promise.all(COST_SWITCHES.map((sw) => loadSwitch(db, sw))), loadThresholds(db), loadOfficeDefaults(db)]);
    const all: Setting[] = [
      schedule,
      ...switches,
      { key: "guard.thresholds", value: thresholds.thresholds, inherited: thresholds.version === 0, version: thresholds.version },
      ...INHERITED_KEYS.map((k) => ({ key: `${DEFAULT_PREFIX}${k}`, value: defaults[k].value, inherited: !defaults[k].set, version: defaults[k].version })),
    ];
    const { items, next } = pageOf(all, c.req.valid("query"));
    return list(c, items, next);
  })
  .openapi(updateSettingRoute, async (c) => {
    const { key } = c.req.valid("param");
    const { version, value, reason } = c.req.valid("json");
    const now = c.var.clock.now();
    if (key === SCHEDULE_KEY) {
      const schedule = await updateSchedule(c.env.DB, { value, version, reason, now }, () => requireStepUp(c));
      await audit(c, "setting.update", key, { value: schedule.value, version: schedule.version, reason });
      // 3 人の alarm を新しい時刻で掛け直す。失敗した社員は、次の alarm まで新しい時刻が効かない。変えた設定は残し、失敗した社員をエラーログに残す
      const woken = await Promise.allSettled(StaffId.options.map((id) => staffDo(c.env, id).wake(now)));
      for (const [i, result] of woken.entries()) {
        if (result.status === "rejected") {
          const cause: unknown = result.reason;
          const error = new Error(`${StaffId.options[i] ?? ""} の予定を組み直せなかった: ${cause instanceof Error ? cause.message : "非 Error の値"}`, { cause });
          await recordError(c.env, { source: "gate", level: "warn", code: "schedule_rearm_failed", error, route: c.req.routePath, traceId: c.var.traceId }, c.var.clock);
        }
      }
      return ok(c, schedule);
    }
    const sw = COST_SWITCHES.find((s) => s.key === key);
    if (sw) {
      const changed = await updateSwitch(c.env.DB, sw, { value, version, reason, now }, () => requireStepUp(c));
      await audit(c, "setting.update", key, { value: changed.value, version: changed.version, reason });
      return ok(c, changed);
    }
    const setting = await updateOfficeDefault(c.env.DB, { key, value, version, reason, now }, () => requireStepUp(c));
    await audit(c, "setting.update", key, { value: setting.value, version: setting.version, reason });
    if (key === MERGE_WHEN_KEY) await protectRepos(c.env, c.var.forge);
    return ok(c, setting);
  });
