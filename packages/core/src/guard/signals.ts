// シグナルの数え方。出来事を数に足し、基準と比べて、止めるか近かったかを返す。数の入れ物は DO が記憶に置く (自動停止の 2 章、3.1、3.2)
import type { GuardEvent, GuardScope, GuardSignal, Judgment, Thresholds } from "../schemas/guard.ts";
import { z } from "../schemas/zod.ts";

/** タスクごとの数。再開、成功、タスクの終わりで消える */
const TaskCounts = z
  .object({
    /** 操作と相手ごとの、最後に数えた時刻 */
    denied: z.record(z.string(), z.number()),
    /** 続いている同じ失敗 */
    failure: z.object({ key: z.string(), count: z.number().int() }).strict().nullable(),
    /** 読んだ外部の文章の出所。1 つでもあれば印が付いている */
    external: z.array(z.string()),
  })
  .strict();

/** タスクごとの数の型 */
export type TaskCounts = z.infer<typeof TaskCounts>;

const Bucket = z.object({ at: z.number(), tokens: z.number(), toolCalls: z.number() }).strict();

/** 5 分ごとの使った量 */
export type Bucket = z.infer<typeof Bucket>;

const Baseline = z.object({ tokens: z.number(), toolCalls: z.number(), days: z.number().int() }).strict();

/** 普段の値。直前 7 日の勤務中の 5 分の値の中央値と、たまった日数 */
export type Baseline = z.infer<typeof Baseline>;

/** 社員 1 人の数。StaffDO の記憶に置き、社員からは見えない */
export const StaffCounts = z
  .object({
    staffId: z.string(),
    tasks: z.record(z.string(), TaskCounts),
    /** 直前 60 分のルールの外の時刻。再開では消えない */
    deniedAt: z.array(z.number()),
    bucket: Bucket.nullable(),
    /** 今の区切りの前に、速すぎる区切りが続いた数 */
    streak: z.object({ tokens: z.number().int(), toolCalls: z.number().int() }).strict(),
    baseline: Baseline.nullable(),
    /** 普段の値を作った日本時間の日 */
    baselineDay: z.string().nullable(),
    /** 閉じたが D1 にまだ書いていない区切り */
    closed: z.array(Bucket),
    /** シグナルと相手ごとの、最後に近かったを残した時刻 */
    nearAt: z.record(z.string(), z.number()),
  })
  .strict();

/** 社員 1 人の数の型 */
export type StaffCounts = z.infer<typeof StaffCounts>;

/** 全体とサービスの数。GuardDO の記憶に置く */
export const OfficeCounts = z
  .object({
    /** サービスごとの、デプロイの後の返事 */
    deploys: z.record(z.string(), z.object({ deployedAt: z.number(), responses: z.number().int(), failures: z.number().int() }).strict()),
    /** 最後の新しい国のログイン */
    loginAt: z.number().nullable(),
    /** オーナーの情報を読んだ時刻 */
    reads: z.array(z.number()),
    nearAt: z.record(z.string(), z.number()),
  })
  .strict();

/** 全体とサービスの数の型 */
export type OfficeCounts = z.infer<typeof OfficeCounts>;

/** 社員の出来事。タスクか社員の範囲で数える */
export type StaffEvent = Extract<GuardEvent, { type: "rule_denied" | "command_result" | "merge_requested" | "usage" | "tool_call" | "external_read" | "sensitive_access" }>;

/** 社員の出来事の種類 */
export const STAFF_EVENTS = ["rule_denied", "command_result", "merge_requested", "usage", "tool_call", "external_read", "sensitive_access"] as const;

/**
 * 出来事が社員の範囲で数える物かを返す
 * @param event 出来事
 * @returns 社員の出来事か
 */
export function isStaffEvent(event: GuardEvent): event is StaffEvent {
  return (STAFF_EVENTS as readonly string[]).includes(event.type);
}

/**
 * 社員の空の数を作る
 * @param staffId 社員 ID
 * @returns 空の数
 */
export function emptyStaffCounts(staffId: string): StaffCounts {
  return { staffId, tasks: {}, deniedAt: [], bucket: null, streak: { tokens: 0, toolCalls: 0 }, baseline: null, baselineDay: null, closed: [], nearAt: {} };
}

/**
 * 全体の空の数を作る
 * @returns 空の数
 */
export function emptyOfficeCounts(): OfficeCounts {
  return { deploys: {}, loginAt: null, reads: [], nearAt: {} };
}

/**
 * 何もしない答えを作る
 * @param scope 範囲
 * @param target 相手
 * @returns none の答え
 */
function none(scope: GuardScope, target: string): Judgment {
  return { action: "none", scope, target, signal: "", measured: 0, threshold: 0 };
}

/**
 * 答えを作る
 * @param action stop か near
 * @param scope 範囲
 * @param target 相手
 * @param signal シグナル
 * @param measured 数えた値
 * @param threshold 基準
 * @returns 答え
 */
function judge(action: "stop" | "near", scope: GuardScope, target: string, signal: GuardSignal, measured: number, threshold: number): Judgment {
  return { action, scope, target, signal, measured, threshold };
}

/**
 * 近かったを、同じシグナルと相手で 1 時間に 1 回にまとめる
 * @param nearAt 最後に残した時刻
 * @param key まとめる鍵
 * @param j 近かったの答え
 * @param now 今の時刻
 * @param th 基準
 * @returns まとめた後の答え
 */
function near(nearAt: Record<string, number>, key: string, j: Judgment, now: number, th: Thresholds): Judgment {
  const last = nearAt[key];
  if (last !== undefined && now - last < th.nearMergeMs) return none(j.scope, j.target);
  nearAt[key] = now;
  return j;
}

/**
 * タスクの数を返す。無ければ作る
 * @param counts 社員の数
 * @param nodeId タスク ID
 * @returns タスクの数
 */
function taskOf(counts: StaffCounts, nodeId: string): TaskCounts {
  const found = counts.tasks[nodeId];
  if (found) return found;
  const made: TaskCounts = { denied: {}, failure: null, external: [] };
  counts.tasks[nodeId] = made;
  return made;
}

/**
 * 社員の出来事を数え、止めるかを返す。counts を書き換える
 * @param counts 社員の数
 * @param event 出来事
 * @param now 今の時刻
 * @param th 基準
 * @returns 答え
 */
export function countStaff(counts: StaffCounts, event: StaffEvent, now: number, th: Thresholds): Judgment {
  switch (event.type) {
    case "rule_denied": {
      const task = taskOf(counts, event.nodeId);
      const key = `${event.operation}|${event.target}`;
      const last = task.denied[key];
      // 同じタスク、同じ操作、同じ相手は 10 分の間 1 回にまとめる
      if (last !== undefined && now - last < th.ruleMergeMs) return none("task", event.nodeId);
      task.denied[key] = now;
      counts.deniedAt = [...counts.deniedAt.filter((at) => now - at < th.staffWindowMs), now];
      if (counts.deniedAt.length >= th.staffRuleDenied) return judge("stop", "staff", counts.staffId, "staff_rule_denied", counts.deniedAt.length, th.staffRuleDenied);
      return judge("stop", "task", event.nodeId, "rule_denied", 1, 1);
    }
    case "command_result": {
      const task = taskOf(counts, event.nodeId);
      if (event.exitCode === 0 && event.failedCheck === null) {
        task.failure = null;
        return none("task", event.nodeId);
      }
      const key = `${event.command}|${String(event.exitCode)}|${event.failedCheck ?? ""}`;
      task.failure = task.failure?.key === key ? { key, count: task.failure.count + 1 } : { key, count: 1 };
      if (task.failure.count >= th.repeatedFailures) return judge("stop", "task", event.nodeId, "repeated_failure", task.failure.count, th.repeatedFailures);
      return none("task", event.nodeId);
    }
    case "merge_requested":
      return event.checksPassed ? none("task", event.nodeId) : judge("stop", "task", event.nodeId, "unchecked_merge", 1, 1);
    case "external_read":
      taskOf(counts, event.nodeId).external.push(event.source);
      return none("task", event.nodeId);
    case "sensitive_access":
      if ((counts.tasks[event.nodeId]?.external.length ?? 0) === 0) return none("staff", counts.staffId);
      return judge("stop", "staff", counts.staffId, "exfiltration", 1, 1);
    case "usage":
      return countRate(counts, now, th, "tokens", event.tokens);
    case "tool_call":
      return countRate(counts, now, th, "toolCalls", 1);
    default:
      return event satisfies never;
  }
}

/**
 * 5 分の区切りを進める。前の区切りが速すぎたかを続いた数に足す
 * @param counts 社員の数
 * @param now 今の時刻
 * @param th 基準
 * @returns 今の区切り
 */
function roll(counts: StaffCounts, now: number, th: Thresholds): Bucket {
  const start = Math.floor(now / th.bucketMs) * th.bucketMs;
  const prev = counts.bucket;
  if (prev && prev.at === start) return prev;
  if (prev) {
    counts.closed.push(prev);
    const adjacent = prev.at === start - th.bucketMs;
    for (const metric of ["tokens", "toolCalls"] as const) {
      const limit = rateLimit(counts, metric, th);
      counts.streak[metric] = adjacent && limit !== null && prev[metric] > limit ? counts.streak[metric] + 1 : 0;
    }
  } else counts.streak = { tokens: 0, toolCalls: 0 };
  const made = { at: start, tokens: 0, toolCalls: 0 };
  counts.bucket = made;
  return made;
}

/**
 * 速さの基準を返す。普段の値が 0 か無ければ比べられない
 * @param counts 社員の数
 * @param metric トークンか操作
 * @param th 基準
 * @returns 5 分の上限。比べられなければ null
 */
function rateLimit(counts: StaffCounts, metric: "tokens" | "toolCalls", th: Thresholds): number | null {
  const base = counts.baseline?.[metric] ?? 0;
  return base > 0 ? base * th.rateMultiplier : null;
}

/**
 * トークンか操作の速さを数える
 * @param counts 社員の数
 * @param now 今の時刻
 * @param th 基準
 * @param metric トークンか操作
 * @param amount 足す数
 * @returns 答え
 */
function countRate(counts: StaffCounts, now: number, th: Thresholds, metric: "tokens" | "toolCalls", amount: number): Judgment {
  const bucket = roll(counts, now, th);
  bucket[metric] += amount;
  const limit = rateLimit(counts, metric, th);
  const signal = metric === "tokens" ? "token_rate" : "tool_rate";
  const target = counts.staffId;
  if (limit === null) return none("staff", target);
  const value = bucket[metric];
  if (value > limit && counts.streak[metric] + 1 >= th.rateBuckets) {
    // 普段の値が 7 日分たまるまでは止めず、近かったとして知らせるだけにする
    if ((counts.baseline?.days ?? 0) >= th.baselineDays) return judge("stop", "staff", target, signal, value, limit);
    return near(counts.nearAt, `${signal}|${target}|held`, judge("near", "staff", target, signal, value, limit), now, th);
  }
  if (value * 10_000 >= limit * th.nearBp) return near(counts.nearAt, `${signal}|${target}`, judge("near", "staff", target, signal, value, limit), now, th);
  return none("staff", target);
}

/**
 * 普段の値を置く。毎日の最初の出来事の前に作り直す
 * @param counts 社員の数
 * @param baseline 普段の値
 * @param day 作った日本時間の日
 */
export function setBaseline(counts: StaffCounts, baseline: Baseline, day: string): void {
  counts.baseline = baseline;
  counts.baselineDay = day;
}

/**
 * 中央値を返す
 * @param values 値
 * @returns 中央値。値が無ければ 0
 */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * タスクの数を 0 に戻す。再開とタスクの終わりで呼ぶ。社員の 60 分の数は残す
 * @param counts 社員の数
 * @param nodeId タスク ID
 */
export function resetTask(counts: StaffCounts, nodeId: string): void {
  // 記録の項目から消すため、残りを並べ直す
  counts.tasks = Object.fromEntries(Object.entries(counts.tasks).filter(([id]) => id !== nodeId));
}

/**
 * 1 つのタスクの働いた時間を最長と比べる
 * @param nodeId タスク ID
 * @param activeMs 止められていた間と待っていた間を除いた時間
 * @param th 基準
 * @returns 答え
 */
export function taskOverrun(nodeId: string, activeMs: number, th: Thresholds): Judgment {
  return activeMs >= th.taskMaxMs ? judge("stop", "task", nodeId, "task_overrun", activeMs, th.taskMaxMs) : none("task", nodeId);
}

/** 全体とサービスの出来事 */
export type OfficeEvent = Exclude<GuardEvent, StaffEvent>;

/**
 * 全体とサービスの出来事を数え、止めるかを返す。counts を書き換える
 * @param counts 全体の数
 * @param event 出来事
 * @param now 今の時刻
 * @param th 基準
 * @returns 答え
 */
export function countOffice(counts: OfficeCounts, event: OfficeEvent, now: number, th: Thresholds): Judgment {
  switch (event.type) {
    case "chain_broken":
    case "ticket_misuse":
    case "threshold_mismatch":
      return judge("stop", "office", "office", "certain_fraud", 1, 1);
    case "login":
      if (event.newCountry) counts.loginAt = now;
      return none("office", "office");
    case "owner_info_read": {
      counts.reads = [...counts.reads.filter((at) => now - at < th.ownerReadWindowMs), now];
      // 新しい国のログインの後 30 分の間だけ、読み出しの多さを重なりとして見る
      if (counts.loginAt === null || now - counts.loginAt > th.loginWindowMs) return none("office", "office");
      const n = counts.reads.length;
      if (n > th.ownerReads) return judge("stop", "office", "office", "stacked_suspicion", n, th.ownerReads);
      if (n * 10_000 >= th.ownerReads * th.nearBp) return near(counts.nearAt, "stacked_suspicion|office", judge("near", "office", "office", "stacked_suspicion", n, th.ownerReads), now, th);
      return none("office", "office");
    }
    case "deploy_result": {
      const target = event.serviceId;
      if (event.kind === "library") return event.buildPassed ? none("service", target) : judge("stop", "service", target, "library_build", 1, 1);
      if (now > event.deployedAt + th.deployWindowMs) return none("service", target);
      const prev = counts.deploys[target];
      const sum = prev?.deployedAt === event.deployedAt ? prev : { deployedAt: event.deployedAt, responses: 0, failures: 0 };
      const next = { deployedAt: event.deployedAt, responses: sum.responses + event.responses, failures: sum.failures + event.failures };
      counts.deploys[target] = next;
      // 返事が 20 件に届くまでは判断を延ばす
      if (next.responses < th.deployMinResponses) return none("service", target);
      const rate = Math.round((next.failures / next.responses) * 10_000);
      const twice = Math.round(event.baselineRate * 10_000 * th.deployMultiplier);
      const threshold = Math.max(th.deployFailureBp, twice);
      if (rate >= th.deployFailureBp && rate > twice) return judge("stop", "service", target, "deploy_failure", rate, threshold);
      if (rate * 10_000 >= threshold * th.nearBp) return near(counts.nearAt, `deploy_failure|${target}`, judge("near", "service", target, "deploy_failure", rate, threshold), now, th);
      return none("service", target);
    }
    default:
      return event satisfies never;
  }
}
