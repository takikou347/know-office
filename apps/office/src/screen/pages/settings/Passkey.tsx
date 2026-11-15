// 設定の画面のパスキー。最初の 1 本をこの端末の認証器で登録する。大事な操作の前の確認に使う (ログインと記録の 3.3)
import { Me, WebAuthnResponse } from "@know-office/core";
import { Alert, Button, Card, Status } from "knowidea-ui";
import { useContext, useState } from "react";
import type { Api } from "../../api.ts";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, failureOf, useLoad } from "../../parts/load.tsx";

/**
 * この端末の認証器でパスキーを作り、ゲートウェイに登録する
 * @param api 入口を呼ぶ口
 * @returns 登録できたら null、だめなら失敗の理由
 */
async function register(api: Api): Promise<Failed | null> {
  const options = await api.api.v1.passkeys.options.$post({ json: { purpose: "register" } });
  if (!options.ok) return failureOf(options);
  const json = (await options.json()).data;
  // WebAuthn の JSON の形はブラウザーが読む。形の違う物はここで投げる
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(json as unknown as PublicKeyCredentialCreationOptionsJSON);
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error("パスキーを作らなかった");
  // 返す形はゲートウェイが @simplewebauthn/server で確かめる
  const res = await api.api.v1.passkeys.$post({ json: WebAuthnResponse.parse(credential.toJSON()) });
  return res.ok ? null : failureOf(res);
}

/** パスキーの今と、最初の 1 本を登録するボタン */
export function Passkey() {
  const api = useContext(ApiContext);
  const [tick, setTick] = useState(0);
  const me = useLoad(Me, (a) => a.api.v1.me.$get(), tick);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  if (me.state === "loading") return <p role="status">パスキーを読んでいます</p>;
  if (me.state === "failed") return <FailedAlert title="パスキーを読めませんでした" failure={me} />;

  const add = async () => {
    if (!api) return;
    setBusy(true);
    setFailure(undefined);
    // 認証器の画面を閉じた時と、つながらない時は、登録できなかった事にする
    const failed = await register(api).catch((): Failed => ({ code: "passkey_cancelled", traceId: null }));
    setBusy(false);
    if (failed) setFailure(failed);
    else setDone(true);
    setTick((t) => t + 1);
  };

  const has = me.data.hasPasskey;
  return (
    <Card
      title="パスキー"
      headingLevel={3}
      badge={<Status kind={has ? "success" : "warn"} label={has ? "登録済み" : "まだ登録していない"} />}
      actions={
        has ? undefined : (
          <Button loading={busy} onClick={() => void add()}>
            パスキーを登録する
          </Button>
        )
      }
    >
      止めたサービスか全体を再開する、基準やルールを変える、鍵を入れ直す前に、パスキーでもう一度確かめます。確認は 15 分だけ有効です。サーバーには人に見せてよい側の鍵だけを置きます
      {done ? (
        <Alert tone="success" live>
          パスキーを登録しました
        </Alert>
      ) : null}
      {failure ? (
        failure.code === "passkey_cancelled" ? (
          <Alert tone="error" live>
            パスキーを作れませんでした。この端末の認証器を確かめて、もう一度押してください
          </Alert>
        ) : (
          <FailedAlert title="パスキーを登録できませんでした" failure={failure} />
        )
      ) : null}
    </Card>
  );
}
