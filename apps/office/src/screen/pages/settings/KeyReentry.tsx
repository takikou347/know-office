// 設定の画面の、全体を止めた後の鍵の入れ直し。GitHub App と Claude の新しい鍵の作り方を 1 ページで案内し、入れたら古い鍵を消すように示す (自動停止の 3.4)
import { GuardKeys, type KeyKind, ReplaceClaudeKeyInput, ReplaceGitHubAppKeyInput } from "@know-office/core";
import { Alert, Button, Card, Stack, Status, TextField } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../../api.ts";
import { withStepUp } from "../../parts/step-up.ts";

/** 入れられなかった時に出す物。不具合を伝えられるよう traceId を添える */
type Failure = { kind: KeyKind; code: string; traceId: string };

const ProblemFields = z.object({ code: z.string(), traceId: z.string() }).loose();

const KEY_LABEL: Record<KeyKind, string> = { github_app: "GitHub App の鍵", claude: "Claude の API の鍵" };

/**
 * 失敗の返事から code と traceId を読む
 * @param kind 入れようとした鍵
 * @param res 返事
 * @returns 失敗
 */
async function failureOf(kind: KeyKind, res: Response): Promise<Failure> {
  const parsed = ProblemFields.safeParse(await res.json().catch(() => null));
  return parsed.success ? { kind, code: parsed.data.code, traceId: parsed.data.traceId } : { kind, code: String(res.status), traceId: "" };
}

/**
 * 入れ直す鍵の今を入口から読む
 * @param api 入口を呼ぶ口
 * @returns 鍵の今。読めなければ null
 */
async function fetchKeys(api: Api): Promise<GuardKeys | null> {
  const res = await api.api.v1.guard.keys.$get().catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()).data;
}

/** 全体を止めた後の鍵を入れ直す欄。止めていない時は何も出さない */
export function KeyReentry() {
  const api = useContext(ApiContext);
  const [keys, setKeys] = useState<GuardKeys | null>(null);
  const [replaced, setReplaced] = useState(false);
  const [busy, setBusy] = useState<KeyKind | null>(null);
  const [failure, setFailure] = useState<Failure>();
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    let live = true;
    if (api) {
      void fetchKeys(api).then((found) => {
        if (live) setKeys(found);
      });
    }
    return () => {
      live = false;
    };
  }, [api]);

  if (!api || !keys) return null;
  if (!keys.held && !replaced) return null;

  const send = async (kind: KeyKind, call: () => Promise<Response>) => {
    setBusy(kind);
    setFailure(undefined);
    const res = await withStepUp(api, call, { required: true }).catch(() => null);
    setBusy(null);
    if (!res) {
      setFailure({ kind, code: "step_up_failed", traceId: "" });
      return;
    }
    if (!res.ok) {
      setFailure(await failureOf(kind, res));
      return;
    }
    const next = z.object({ data: GuardKeys }).parse(await res.json()).data;
    setReplaced(true);
    setKeys(next);
  };

  const sendGitHub = () => {
    const json = ReplaceGitHubAppKeyInput.safeParse({ privateKey: privateKey.trim(), webhookSecret });
    if (!json.success) {
      setFailure({ kind: "github_app", code: "validation_failed", traceId: "" });
      return;
    }
    void send("github_app", () => api.api.v1.guard.keys["github-app"].$put({ json: json.data }));
  };

  const sendClaude = () => {
    const json = ReplaceClaudeKeyInput.safeParse({ apiKey: apiKey.trim() });
    if (!json.success) {
      setFailure({ kind: "claude", code: "validation_failed", traceId: "" });
      return;
    }
    void send("claude", () => api.api.v1.guard.keys.claude.$put({ json: json.data }));
  };

  const done = (kind: KeyKind) => !keys.pending.includes(kind);

  return (
    <Stack gap={4}>
      {keys.held ? (
        <Alert tone="error" title="全体を止めたので、外の鍵を入れ直す">
          止める前の GitHub App の鍵と Claude の API の鍵は使いません。2 つとも新しい鍵を入れると、自動停止の画面から全体を再開できます。入れる時にパスキーで確かめます
        </Alert>
      ) : (
        <Alert tone="success" title="鍵を入れ直しました">
          GitHub の App の設定で古い秘密鍵を、Anthropic の Console で古い API の鍵を消してから、自動停止の画面で全体を再開してください
        </Alert>
      )}
      <Card
        title={KEY_LABEL.github_app}
        headingLevel={2}
        badge={<Status kind={done("github_app") ? "success" : "pending"} label={done("github_app") ? "入れ直した" : "まだ"} />}
        actions={
          <Button loading={busy === "github_app"} disabled={done("github_app")} onClick={sendGitHub}>
            GitHub App の鍵を入れる
          </Button>
        }
      >
        <ol>
          <li>GitHub の Settings、Developer settings、GitHub Apps で know-office の App を開く</li>
          <li>Private keys の「Generate a private key」で新しい秘密鍵を作り、落とした PEM の中身を下に貼る</li>
          <li>Webhook secret を新しい値に変え、同じ値を下に入れる</li>
          <li>入れた後に、古い秘密鍵を Delete で消す</li>
        </ol>
        <p>App を消した時やインストールを外した時は、GitHub と連携し直すと入れ直した事になります</p>
        <TextField label="新しい秘密鍵 (PEM)" multiline rows={6} value={privateKey} disabled={done("github_app")} autoComplete="off" spellCheck={false} onChange={(e) => setPrivateKey(e.target.value)} />
        <TextField label="新しい Webhook secret" type="password" value={webhookSecret} disabled={done("github_app")} autoComplete="off" hint="16 字から 200 字" onChange={(e) => setWebhookSecret(e.target.value)} />
      </Card>
      <Card
        title={KEY_LABEL.claude}
        headingLevel={2}
        badge={<Status kind={done("claude") ? "success" : "pending"} label={done("claude") ? "入れ直した" : "まだ"} />}
        actions={
          <Button loading={busy === "claude"} disabled={done("claude")} onClick={sendClaude}>
            Claude の鍵を入れる
          </Button>
        }
      >
        <ol>
          <li>Anthropic の Console の API keys で「Create Key」を押し、新しい鍵を下に貼る</li>
          <li>入れた後に、古い鍵を Delete で消す</li>
        </ol>
        <TextField label="新しい API の鍵" type="password" value={apiKey} disabled={done("claude")} autoComplete="off" hint="sk-ant- で始まる" onChange={(e) => setApiKey(e.target.value)} />
      </Card>
      {failure ? (
        <Alert tone="error" live>
          {KEY_LABEL[failure.kind]}を入れられませんでした ({failure.code})。{failure.traceId ? `不具合を伝える時は ${failure.traceId} を添えてください` : "入れた値を確かめてください"}
        </Alert>
      ) : null}
    </Stack>
  );
}
