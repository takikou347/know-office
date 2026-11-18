// GitHub の操作の判断、main に入れる条件、ルールセットの中身、リポジトリの名前の形 (GitHub の連携の 3.3)
import { describe, expect, it } from "vitest";
import { decideRepo, DEFAULT_SERVICE_RULES, mainRuleset, missingConditions, ownerGuardedPath, RepoName, type ServiceRules } from "../src/index.ts";

const RULES: ServiceRules = DEFAULT_SERVICE_RULES;
const REPO = "example/knowidea-ui";

/**
 * 1 つのファイルを変える push を通すかを見る
 * @param path 変えるファイル
 * @returns 通すなら true
 */
function ok(path: string): boolean {
  return decideRepo({ action: "push", repo: REPO, paths: [path] }, { repos: null, rules: RULES }).allow;
}

describe("GitHub の操作の判断", () => {
  it("触れるリポジトリ、手で止める、できる操作、触れない所の順に断る", () => {
    expect(decideRepo({ action: "merge", repo: REPO, paths: [] }, { repos: null, rules: RULES })).toEqual({ allow: true, reason: "ルールの中" });
    expect(decideRepo({ action: "merge", repo: REPO, paths: [] }, { repos: ["example/other"], rules: { ...RULES, paused: true } })).toEqual({ allow: false, reason: "触れるリポジトリでない" });
    expect(decideRepo({ action: "merge", repo: REPO, paths: [] }, { repos: [REPO], rules: { ...RULES, paused: true, actions: [] } })).toEqual({ allow: false, reason: "手で止めている" });
    expect(decideRepo({ action: "merge", repo: REPO, paths: [".github/workflows/a.yml"] }, { repos: [], rules: RULES })).toMatchObject({ reason: "触れるリポジトリでない" });
    expect(decideRepo({ action: "push", repo: REPO, paths: [".github/workflows/a.yml"] }, { repos: null, rules: { ...RULES, actions: ["read"] } })).toEqual({ allow: false, reason: "ルールで許していない操作: push" });
    expect(decideRepo({ action: "push", repo: REPO, paths: ["src/a.ts", ".github/workflows/a.yml"] }, { repos: null, rules: RULES })).toEqual({
      allow: false,
      reason: "ルールで触れない所: .github/workflows/a.yml",
      path: ".github/workflows/a.yml",
    });
  });

  it("変えたファイルが分からない時は断る", () => {
    expect(decideRepo({ action: "push", repo: REPO, paths: null }, { repos: null, rules: RULES })).toEqual({ allow: false, reason: "変えたファイルを確かめ切れない" });
  });

  it("触れない所は道の区切りで見て、.. で回り込んだ道も当てる", () => {
    expect(ok(".github/workflows-old/a.yml")).toBe(true);
    expect(ok(".github/workflowsa.yml")).toBe(true);
    expect(ok("src/../.github/workflows/a.yml")).toBe(false);
    expect(ok("./.github/workflows/a.yml")).toBe(false);
  });
});

describe("main に入れる条件", () => {
  it("満たしていない条件だけを並べた順に返す", () => {
    expect(missingConditions(["checks", "reviewer", "owner"], { checks: true, reviewer: true, owner: false })).toEqual(["owner"]);
    expect(missingConditions(["owner", "checks"], { checks: false, reviewer: false, owner: false })).toEqual(["owner", "checks"]);
    expect(missingConditions(["reviewer"], { checks: false, reviewer: true, owner: false })).toEqual([]);
  });
});

describe("オーナーの承認も要る守りのファイル", () => {
  it("ルールの判断、シグナル、自動停止、vault のファイルに当て、名前が似ているだけのファイルと .. で外れた道は当てない", () => {
    expect(ownerGuardedPath(["src/a.ts", "packages/core/src/rules/shell.ts"])).toBe("packages/core/src/rules/shell.ts");
    expect(ownerGuardedPath(["packages/core/src/guard/signals.ts"])).toBe("packages/core/src/guard/signals.ts");
    expect(ownerGuardedPath(["apps/office/src/gate/guard/observe.ts"])).toBe("apps/office/src/gate/guard/observe.ts");
    expect(ownerGuardedPath(["apps/office/src/gate/auth/vault.ts"])).toBe("apps/office/src/gate/auth/vault.ts");
    expect(ownerGuardedPath(["packages/core/src/keys.ts"])).toBe("packages/core/src/keys.ts");
    expect(ownerGuardedPath(["apps/office/src/gate/do/guard.ts"])).toBe("apps/office/src/gate/do/guard.ts");
    expect(ownerGuardedPath(["apps/office/src/gate/auth/guard-book.ts"])).toBe("apps/office/src/gate/auth/guard-book.ts");
    expect(ownerGuardedPath(["packages/core/src/keys.test.ts", "apps/office/src/gate/do/guard.tsx"])).toBeUndefined();
    expect(ownerGuardedPath(["apps/office/src/gate/x/../guard/a.ts"])).toBe("apps/office/src/gate/x/../guard/a.ts");
    expect(ownerGuardedPath(["packages/core/src/rules.md", "apps/office/src/gate/auth/vault.test.ts", "apps/office/src/gate/guardian/a.ts", "packages/core/src/rules/../id.ts"])).toBeUndefined();
    expect(ownerGuardedPath([])).toBeUndefined();
  });
});

describe("ルールセットの中身", () => {
  it("承認の条件があれば main を進めるのを App と管理者に限り、チェックの名前は重ねない", () => {
    const body = mainRuleset(["checks", "owner"], ["verify", "verify", "e2e"], 7);
    expect(body.rules).toEqual([
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "verify" }, { context: "e2e" }] } },
      { type: "update" },
    ]);
    expect(body.bypass_actors.map((a) => [a.actor_type, a.actor_id])).toEqual([
      ["Integration", 7],
      ["RepositoryRole", 5],
    ]);
  });

  it("チェックが 1 つも無ければチェックの合格を掛けない", () => {
    expect(mainRuleset(["checks"], [], 7).rules.map((r) => r.type)).toEqual(["deletion", "non_fast_forward", "required_linear_history"]);
  });
});

describe("リポジトリの名前", () => {
  it("URL の道を回り込む形と長すぎる名前を断る", () => {
    for (const good of ["example/know-office", "a/b", "example/.github", "a-b/c.d_e", `${"a".repeat(39)}/${"b".repeat(100)}`]) expect(RepoName.safeParse(good).success).toBe(true);
    for (const bad of ["example/..", "example/.", "../x", "-a/b", "a/b/c", "a", "a/", "/b", "a b/c", `${"a".repeat(40)}/b`, `a/${"b".repeat(101)}`, "a/b%2f.."]) expect(RepoName.safeParse(bad).success).toBe(false);
  });
});
