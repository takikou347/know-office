// DO の RPC を越えて来た失敗を AppError に戻す。workerd は投げた Error の code を残すが、AppError のクラスは残さない
import { AppError, ErrorCode } from "@know-office/core";

/** DO が断る時に投げる code。これ以外は想定外として 500 にする */
const RPC_CODES = new Set<ErrorCode>(["validation_failed", "not_found", "conflict", "stopped"]);

/**
 * DO の RPC が投げた失敗を、code を持つ AppError にして投げ直す。断る code でなければそのまま投げ、onError が 500 にする
 * @param error RPC が投げた物
 * @returns 返さない
 * @throws validation_failed、not_found、conflict、stopped DO がその code で断った時
 */
export function rethrowRpc(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Error && "code" in error) {
    const code = ErrorCode.safeParse(error.code);
    if (code.success && RPC_CODES.has(code.data)) throw new AppError(code.data, error.message);
  }
  throw error;
}
