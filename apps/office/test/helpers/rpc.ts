// テストの DO の代わりが、workerd の RPC と同じ形で投げ直す包み
import { AppError } from "@know-office/core";

/**
 * workerd の RPC と同じく、DO の中で投げた AppError を、code を持った別の Error にして投げ直す。ゲートウェイは instanceof に頼れない
 * @param call DO のメソッド
 * @returns RPC を越えた形で投げるメソッド
 */
export function overRpc<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw Object.assign(new Error(error.message), { name: error.name, code: error.code, remote: true });
    }
  };
}
