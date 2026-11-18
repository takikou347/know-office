// GitHub の操作をオーナーのルールと照らす判断と、main に入れる条件、公開のリポジトリに掛けるルールセットの中身 (GitHub の連携の 3.3)
// rules/ は schemas/ を読まずに型のチェックに掛かるので、設定の形はここに同じ形で書く
import { protectedPath } from "./path.ts";

/** main に入れる条件の 1 つ。core の ReleaseCondition と同じ値 */
type ReleaseCondition = "checks" | "reviewer" | "owner";

/** 判断に使うサービスの設定のうち、GitHub の操作に効く項目。core の ServiceRules と同じ形 */
type RepoRules = {
  /** できる操作 */
  actions: readonly string[];
  /** main に入れる条件 */
  mergeWhen: readonly ReleaseCondition[];
  /** 触れない所 */
  protectedPaths: readonly string[];
  /** 手で止めているか */
  paused: boolean;
};

/** GitHub の操作 1 つ。paths はその操作で変わるファイル (リポジトリの頭からの道) */
export type RepoRequest = {
  /** 操作の種類 */
  action: "read" | "branch" | "push" | "pull_request" | "merge" | "issue";
  /** リポジトリ */
  repo: string;
  /** 変わるファイル。確かめ切れない時は null */
  paths?: readonly string[] | null;
};

/** 判断の前提。触れるリポジトリと、そのリポジトリに効くサービスの設定 */
export type RepoScope = {
  /** 触れるリポジトリ。null は連携したものすべて */
  repos: readonly string[] | null;
  /** そのリポジトリに効く設定 */
  rules: RepoRules;
};

/** 判断。通さない時の reason は記録とタスクの出来事に残す */
export type RepoDecision = { allow: true; reason: string } | { allow: false; reason: string; path?: string };

/** ルールセットの名前。この名前の物だけを know-office が持ち、置き換える */
export const RULESET_NAME = "know-office";

/** GitHub の決まった役「Admin」の番号。ルールセットの bypass_actors の RepositoryRole に使う */
const ADMIN_ROLE = 5;

/**
 * GitHub の操作をルールと照らす。触れるリポジトリ、手で止める、できる操作、触れない所の順に見る
 * @param req 操作
 * @param scope 触れるリポジトリと、そのリポジトリの設定
 * @returns 通すか、理由、当たった道
 */
export function decideRepo(req: RepoRequest, scope: RepoScope): RepoDecision {
  if (scope.repos !== null && !scope.repos.includes(req.repo)) return { allow: false, reason: "触れるリポジトリでない" };
  if (scope.rules.paused) return { allow: false, reason: "手で止めている" };
  if (!scope.rules.actions.includes(req.action)) return { allow: false, reason: `ルールで許していない操作: ${req.action}` };
  // 変わるファイルが分からない時は、触れない所に当たらないと言えないので断る
  if (req.paths === null) return { allow: false, reason: "変えたファイルを確かめ切れない" };
  const hit = (req.paths ?? []).find((p) => protectedPath(p, "/", scope.rules.protectedPaths));
  if (hit !== undefined) return { allow: false, reason: `ルールで触れない所: ${hit}`, path: hit };
  return { allow: true, reason: "ルールの中" };
}

/**
 * know-office 自身のリポジトリで、変える PR にオーナーの承認も要るファイル (タスクとレビューの 3.3)。ルールの判断、シグナルの数え方、自動停止、vault、鍵を作る所、止める数とロックアウトを数える所
 * この一覧も rules/ にあるので、一覧を弱める変更にもオーナーの承認が要る
 */
export const OWNER_GUARDED_PATHS = [
  "packages/core/src/rules/",
  "packages/core/src/guard/",
  "packages/core/src/keys.ts",
  "apps/office/src/gate/guard/",
  "apps/office/src/gate/auth/vault.ts",
  "apps/office/src/gate/auth/guard-book.ts",
  "apps/office/src/gate/do/guard.ts",
] as const;

/**
 * 変わるファイルのうち、オーナーの承認も要るファイルを 1 つ返す。道の区切りで見て、.. を畳んでから当てる
 * @param paths 変わるファイル (リポジトリの頭からの道)
 * @returns 当たったファイル。無ければ undefined
 */
export function ownerGuardedPath(paths: readonly string[]): string | undefined {
  return paths.find((p) => protectedPath(p, "/", OWNER_GUARDED_PATHS));
}

/**
 * main に入れる条件のうち、まだ満たしていない物を返す
 * @param when main に入れる条件
 * @param met 条件ごとに満たしたか
 * @returns 満たしていない条件。空ならそろった
 */
export function missingConditions(when: readonly ReleaseCondition[], met: Readonly<Record<ReleaseCondition, boolean>>): ReleaseCondition[] {
  return when.filter((c) => !met[c]);
}

/** GitHub のルールセットの本文 (POST /repos/{o}/{r}/rulesets) */
export type RulesetBody = {
  name: string;
  target: "branch";
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: ({ type: "deletion" | "non_fast_forward" | "required_linear_history" | "update" } | { type: "required_status_checks"; parameters: { strict_required_status_checks_policy: boolean; required_status_checks: { context: string }[] } })[];
  bypass_actors: { actor_id: number; actor_type: "Integration" | "RepositoryRole"; bypass_mode: "always" }[];
};

/**
 * main に入れる条件から、公開のリポジトリの既定のブランチに掛けるルールセットを作る
 * 消すのと force push を断り、一直線の履歴にする。条件にチェックがあれば checks のチェックの合格を求め、承認があれば main を進められるのを App とリポジトリの管理者に限る
 * @param when main に入れる条件
 * @param checks 合格を求めるチェックの名前
 * @param appId GitHub App の ID
 * @returns ルールセットの本文
 */
export function mainRuleset(when: readonly ReleaseCondition[], checks: readonly string[], appId: number): RulesetBody {
  const rules: RulesetBody["rules"] = [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }];
  // 名前の無いチェックの合格は GitHub が受けないので、チェックが 1 つも無い時は掛けない。ゲートウェイの判断が守る
  if (when.includes("checks") && checks.length > 0) {
    rules.push({ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [...new Set(checks)].map((context) => ({ context })) } });
  }
  const approval = when.includes("reviewer") || when.includes("owner");
  if (approval) rules.push({ type: "update" });
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules,
    bypass_actors: approval
      ? [
          { actor_id: appId, actor_type: "Integration", bypass_mode: "always" },
          { actor_id: ADMIN_ROLE, actor_type: "RepositoryRole", bypass_mode: "always" },
        ]
      : [],
  };
}
