// ログインセッションとパスキーの返す形と入力。名前は v1.yaml の components/schemas と同じ (ログインと記録の 1.1)
import { z } from "zod";

/** ログインセッション 1 件。current は今の要求のセッションか */
export const Session = z
  .object({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    current: z.boolean(),
    ip: z.string(),
    country: z.string(),
    userAgent: z.string(),
  })
  .strict()
  .meta({ id: "Session" });

/** ログインセッションの型 */
export type Session = z.infer<typeof Session>;

/** ログイン中の人と今のセッション */
export const Me = z
  .object({
    email: z.email(),
    sessionId: z.uuid(),
    stepUpUntil: z.iso.datetime().nullable(),
    hasPasskey: z.boolean(),
  })
  .strict()
  .meta({ id: "Me" });

/** ログイン中の人の型 */
export type Me = z.infer<typeof Me>;

/** パスキーの確認が通った後の期限 */
export const StepUp = z.object({ stepUpUntil: z.iso.datetime() }).strict().meta({ id: "StepUp" });

/** パスキーの確認の結果の型 */
export type StepUp = z.infer<typeof StepUp>;

/** WebAuthn のオプションを頼む入力。登録か確認か */
export const PasskeyOptionsInput = z
  .object({ purpose: z.enum(["register", "step_up"]) })
  .strict()
  .meta({ id: "PasskeyOptionsInput" });

/** WebAuthn のオプションを頼む入力の型 */
export type PasskeyOptionsInput = z.infer<typeof PasskeyOptionsInput>;

/** WebAuthn の PublicKeyCredentialCreationOptions か RequestOptions の JSON。中身は @simplewebauthn/server が作る */
export const PasskeyOptions = z.looseObject({}).meta({ id: "PasskeyOptions" });

/** ブラウザーが返した WebAuthn の返事。中身は @simplewebauthn/server が確かめる */
export const WebAuthnResponse = z.looseObject({}).meta({ id: "WebAuthnResponse" });

/** 登録したパスキー。鍵そのものは返さない */
export const Passkey = z.object({ id: z.uuid(), createdAt: z.iso.datetime() }).strict().meta({ id: "Passkey" });

/** 登録したパスキーの型 */
export type Passkey = z.infer<typeof Passkey>;
