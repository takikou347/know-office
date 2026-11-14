// パスキーの登録と確認の形と、パスキーの確認の要り方 (ログインと記録の 3.3)
import { AppError } from "@know-office/core";
import type { Context } from "hono";
import { z } from "zod";
import type { GateEnv } from "../env.ts";

// ここの形は @simplewebauthn/server に渡す前に型を絞るためだけの物で、API の形 (core の WebAuthnResponse) は変えないのでゲートウェイに置く

/** 認証器のつなぎ方。WebAuthn の AuthenticatorTransportFuture */
export const Transports = z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]));

const ExtensionResults = z.object({
  appid: z.boolean().optional(),
  credProps: z.object({ rk: z.boolean().optional() }).optional(),
  hmacCreateSecret: z.boolean().optional(),
});

/** ブラウザーが返した登録の返事。@simplewebauthn/server の RegistrationResponseJSON と同じ形 */
export const RegistrationResponse = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: ExtensionResults,
  response: z.object({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    authenticatorData: z.string().optional(),
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: z.string().optional(),
  }),
});

/** ブラウザーが返した確認の返事。@simplewebauthn/server の AuthenticationResponseJSON と同じ形 */
export const AuthenticationResponse = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: ExtensionResults,
  response: z.object({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string().optional(),
  }),
});

/**
 * WebAuthn の宛先 (rpID と origin) を返す。Access の後ろでは要求の URL が公開の URL
 * @param c 要求の文脈
 * @returns rpID と origin
 */
export function relyingParty(c: Context<GateEnv>): { rpID: string; origin: string } {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

/**
 * 15 分のうちにパスキーで確かめたかを見る。大事な操作のルートの頭で呼ぶ
 * @param c 要求の文脈
 * @throws step_up_required 確認が無いか、15 分を過ぎた時
 */
export function requireStepUp(c: Context<GateEnv>): void {
  const until = c.var.session?.stepUpUntil ?? null;
  if (until === null || until <= c.var.clock.now()) throw new AppError("step_up_required", "パスキーの確認が要る");
}
