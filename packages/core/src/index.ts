// ゲートウェイ、社員 DO、ワークスペース、画面が共に使う型と判断を置く
export { systemClock, type Clock } from "./clock.ts";
export { canonicalJson, sha256Hex } from "./hash.ts";
export { allowedFetch, FETCH_TIMEOUT_MS, type Fetcher } from "./fetch.ts";
export { newId } from "./id.ts";
export { fromBase64, fromBase64url, toBase64, toBase64url } from "./encoding.ts";
export { deriveKey, type KeyPurpose } from "./keys.ts";
export { log, redact, redactText } from "./log.ts";
export { jstClock, jstDay, jstYear } from "./time.ts";
export { AppError, ERROR_CODES, PROBLEMS, type FieldError } from "./errors.ts";
export { AuditInput } from "./schemas/audit.ts";
export { Me, Passkey, PasskeyOptions, PasskeyOptionsInput, Session, StepUp, WebAuthnResponse } from "./schemas/auth.ts";
export { ErrorCode, Health, ListMeta, Meta, Part, Problem } from "./schemas/common.ts";

/**
 * 部分ごとの稼働確認の返事を作る
 * @param part 応答した部分
 * @returns 稼働確認の返事
 */
export function health(part: "gate" | "screen" | "workspace"): { ok: true; part: "gate" | "screen" | "workspace" } {
  return { ok: true, part };
}
