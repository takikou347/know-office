// 大事な操作の前のパスキーの確認。ゲートウェイが step_up_required を返したら、パスキーで確かめてから 1 度だけ呼び直す (ログインと記録の 3.3)
import { WebAuthnResponse } from "@know-office/core";
import { z } from "zod";
import type { Api } from "../api.ts";

const ProblemCode = z.object({ code: z.string() }).loose();

/**
 * 返事が、パスキーの確認が切れている時の 401 かを見る
 * @param res 返事
 * @returns step_up_required の 401 か
 */
async function stepUpRequired(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = ProblemCode.safeParse(await res.clone().json().catch(() => null));
  return body.success && body.data.code === "step_up_required";
}

/**
 * パスキーで確かめる。ゲートウェイから challenge を受け、ブラウザーの認証器で署名して返す
 * @param api 入口を呼ぶ口
 * @returns 確かめられたら null、だめなら失敗の返事
 */
async function stepUp(api: Api): Promise<Response | null> {
  const options = await api.api.v1.passkeys.options.$post({ json: { purpose: "step_up" } });
  if (!options.ok) return options;
  const json = (await options.json()).data;
  // WebAuthn の JSON の形はブラウザーが読む。形の違う物はここで投げる
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(json as unknown as PublicKeyCredentialRequestOptionsJSON);
  const credential = await navigator.credentials.get({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("パスキーを選ばなかった");
  // 返す形はゲートウェイが @simplewebauthn/server で確かめる
  const answer = WebAuthnResponse.parse(credential.toJSON());
  const res = await api.api.v1.me["step-up"].$post({ json: answer });
  return res.ok ? null : res;
}

/**
 * 呼んで、パスキーの確認が切れていればパスキーで確かめてから 1 度だけ呼び直す
 * @param api 入口を呼ぶ口
 * @param call 呼ぶ操作
 * @returns 最後の返事。確かめられなければ確認の失敗の返事
 */
export async function withStepUp(api: Api, call: () => Promise<Response>): Promise<Response> {
  const first = await call();
  if (!(await stepUpRequired(first))) return first;
  const failed = await stepUp(api);
  return failed ?? call();
}
