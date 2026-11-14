// 社員の操作をオーナーのルールと照らし、通すか断るかを決める (社員が考えるの 3.4)
import type { Operation } from "./operation.ts";
import { inside, protectedPath } from "./path.ts";
import { shellRefusal } from "./shell.ts";

/** 判断の前提。オーナーのルールとタスクの様子 */
export type RuleContext = {
  /** 社員が触れてよい置き場 */
  workRoot: string;
  /** 書けない所。リポジトリの頭からの道の頭 */
  protectedPaths: readonly string[];
  /** 社員が読んでよいオーナーの情報の項目 */
  ownerInfoItems: readonly string[];
  /** そのタスクが外部の文章を読んだ印 */
  external: boolean;
};

/** 初期のルール。オーナーの情報はどの項目も読ませない */
export const DEFAULT_RULES: RuleContext = { workRoot: "/work", protectedPaths: [".github/workflows/"], ownerInfoItems: [], external: false };

/** ルールの判断。marksExternal はそのタスクに外部の文章の印を付けるか */
export type RuleDecision = {
  /** 通すか */
  allow: boolean;
  /** 社員に返す理由 */
  reason: string;
  /** 外部の文章の印を付けるか */
  marksExternal: boolean;
};

/**
 * 通す判断を作る
 * @param reason 理由
 * @param marksExternal 外部の文章の印を付けるか
 * @returns 通す判断
 */
function allow(reason: string, marksExternal = false): RuleDecision {
  return { allow: true, reason, marksExternal };
}

/**
 * 断る判断を作る
 * @param reason 理由
 * @returns 断る判断
 */
function deny(reason: string): RuleDecision {
  return { allow: false, reason, marksExternal: false };
}

/**
 * 終わりの無い種類を受けた時に型のチェックを落とす
 * @param op 判断の無い操作
 * @returns 返らない
 */
function unreachable(op: never): never {
  throw new Error(`判断の無い操作の種類: ${JSON.stringify(op)}`);
}

/**
 * 操作をルールと照らし、通すか断るかを決める
 * @param op toOperation() で直した操作
 * @param ctx オーナーのルールとタスクの様子
 * @returns 通すか、理由、外部の文章の印を付けるか
 */
export function decide(op: Operation, ctx: RuleContext): RuleDecision {
  switch (op.kind) {
    case "file.read":
    case "file.write": {
      if (op.target === "") return deny("道の無いファイルの操作は断る");
      if (!op.paths.every((p) => inside(p, ctx.workRoot))) return deny(`${ctx.workRoot} の外は触れない`);
      if (op.kind === "file.write" && op.paths.some((p) => protectedPath(p, ctx.workRoot, ctx.protectedPaths))) return deny("ルールで触れない所には書けない");
      return allow(`${ctx.workRoot} の下`);
    }
    case "shell.run": {
      if (op.target === "") return deny("命令の無いシェルは断る");
      const refusal = shellRefusal(op.target, ctx.workRoot, ctx.protectedPaths);
      return refusal === null ? allow(`${ctx.workRoot} の下の命令`) : deny(refusal);
    }
    case "web.fetch":
      if (!/^https?:\/\//i.test(op.target)) return deny("http か https の URL だけを読む");
      return allow("Web の文章はデータとして読む", true);
    case "web.search":
      if (op.target.trim() === "") return deny("言葉の無い検索は断る");
      return allow("Web の文章はデータとして読む", true);
    case "agent.spawn":
      if (op.target.trim() === "") return deny("頼む事の無い手分けは断る");
      return allow("中のツールにも同じ判断を掛ける");
    case "owner_info.read":
      if (ctx.external) return deny("外部の文章を読んだタスクにオーナーの情報は渡さない");
      if (!ctx.ownerInfoItems.includes(op.target)) return deny("ルールで許していない項目");
      return allow("ルールで許した項目");
    case "office.tool":
      return allow("社員のツール");
    case "secret.read":
      return deny("鍵には触れない");
    case "guard.access":
      return deny("自動停止の基準と数には触れない");
    case "staff.manage":
      return deny("社員は社員を触れない");
    case "unknown":
      return deny("知らないツールは断る");
    default:
      return unreachable(op.kind);
  }
}
