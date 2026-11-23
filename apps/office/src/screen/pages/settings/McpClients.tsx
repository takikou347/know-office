// 設定の画面の MCP の連携。外の AI がつなぐ鍵を作り、1 度だけ見せ、一覧で切る (ログインと記録の 3.10)
import { CreatedMcpClient, McpClient, McpScope } from "@know-office/core";
import { MCP_SCOPES } from "@know-office/core/master/mcp-scope";
import { labelOf, optionsOf } from "@know-office/core/master/master";
import { Alert, Button, CodeBlock, List, SegmentedControl, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { jstDateTime } from "../../format.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { Part } from "../../parts/section.tsx";

/** MCP の連携の一覧と、作る欄と、切るボタン */
export function McpClients() {
  const api = useContext(ApiContext);
  const [tick, setTick] = useState(0);
  const loaded = useLoad(z.array(McpClient), (a) => a.api.v1["mcp-clients"].$get(), tick);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<McpScope>("read");
  const [busy, setBusy] = useState<string | null>(null);
  const [token, setToken] = useState<string>();
  const [done, setDone] = useState<string>();
  const [failure, setFailure] = useState<Failed>();

  const create = async () => {
    if (!api) return;
    setBusy("create");
    setDone(undefined);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1["mcp-clients"].$post({ json: { name, scope } }), { required: true });
    setBusy(null);
    if (sent.ok) {
      setToken(z.object({ data: CreatedMcpClient }).parse(await sent.res.json()).data.token);
      setName("");
      setTick((t) => t + 1);
    } else setFailure(sent.failure);
  };

  const revoke = async (client: McpClient) => {
    if (!api) return;
    setBusy(client.id);
    setDone(undefined);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1["mcp-clients"][":mcpClientId"].$delete({ param: { mcpClientId: client.id } }));
    setBusy(null);
    if (sent.ok) setDone(`${client.name}の連携を切りました`);
    else setFailure(sent.failure);
    setTick((t) => t + 1);
  };

  const active = loaded.state === "ok" ? loaded.data.filter((c) => c.revokedAt === null) : [];
  return (
    <Part title="MCP の連携">
      <Stack gap={3}>
        <p>外の AI (Claude のプロジェクトなど) が MCP で know-office を読み、承認と社員への発言を出せます。パスキーが要る承認は画面で出します。</p>
        {loaded.state === "loading" ? <p role="status">MCP の連携を読んでいます</p> : null}
        {loaded.state === "failed" ? <FailedAlert title="MCP の連携を読めませんでした" failure={loaded} /> : null}
        {loaded.state === "ok" && active.length === 0 ? <p>MCP の連携はありません</p> : null}
        {active.length > 0 ? (
          <List
            label="MCP の連携"
            items={active.map((c) => ({
              id: c.id,
              title: `${c.name} (${labelOf(MCP_SCOPES, c.scope)})`,
              meta: `${jstDateTime(c.createdAt)} に作成、最後に使った時刻 ${c.lastUsedAt === null ? "なし" : jstDateTime(c.lastUsedAt)}`,
              side: (
                <Button variant="quiet" aria-label={`${c.name}の MCP の連携を切る`} loading={busy === c.id} disabled={busy !== null && busy !== c.id} onClick={() => void revoke(c)}>
                  切る
                </Button>
              ),
            }))}
          />
        ) : null}
        <TextField label="つなぐ先の名前" value={name} onChange={(e) => setName(e.target.value)} />
        <SegmentedControl
          label="できる事"
          options={optionsOf(MCP_SCOPES)}
          value={scope}
          onValueChange={(v) => setScope(McpScope.catch(scope).parse(v))}
        />
        <Stack direction="row" gap={2}>
          <Button loading={busy === "create"} disabled={name.trim() === "" || (busy !== null && busy !== "create")} onClick={() => void create()}>
            MCP の連携を作る
          </Button>
        </Stack>
        {token ? (
          <Alert tone="success" live>
            鍵はこの 1 度だけ出します。MCP の設定の Authorization: Bearer に入れてください
            <CodeBlock code={token} label="MCP の連携の鍵" />
          </Alert>
        ) : null}
        {done ? (
          <Alert tone="success" live>
            {done}
          </Alert>
        ) : null}
        {failure ? <FailedAlert title="MCP の連携を変えられませんでした" failure={failure} /> : null}
      </Stack>
    </Part>
  );
}
