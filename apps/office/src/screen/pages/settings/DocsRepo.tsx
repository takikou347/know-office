// 設定の画面の設計書のリポジトリ。触れるリポジトリのうち非公開の物から 1 つ選ぶ。試作に進めた案の設計書はここに置く (開発の回し方の 3.2)
import { DocsRepo as DocsRepoValue, GitHubLink, Repo, UpdateDocsRepoInput } from "@know-office/core";
import { Alert, Button, Field, Select, Stack, TextField } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { Part } from "../../parts/section.tsx";

/** 設計書のリポジトリの部分。今の値を読み、連携していれば非公開のリポジトリから選び直して保存する */
export function DocsRepo() {
  const [tick, setTick] = useState(0);
  const docs = useLoad(DocsRepoValue, (a) => a.api.v1.devloop["docs-repo"].$get(), tick);
  const link = useLoad(GitHubLink, (a) => a.api.v1.github.link.$get());
  if (docs.state === "loading" || link.state === "loading") return <p role="status">設計書のリポジトリを読んでいます</p>;
  if (docs.state === "failed") return <FailedAlert title="設計書のリポジトリを読めませんでした" failure={docs} />;
  if (link.state === "failed") return <FailedAlert title="GitHub との連携を読めませんでした" failure={link} />;
  return (
    <Part title="設計書のリポジトリ">
      <p>試作に進めた案の設計書は、ここで選んだ非公開のリポジトリの services/&lt;名前&gt;/ に置きます。サービスのリポジトリは選べません。選ぶ前にパスキーで確かめます</p>
      <p>{docs.data.repo === null ? "まだ選んでいません。選ぶまで案を試作に進められません" : `今は ${docs.data.repo} です`}</p>
      {link.data.state === "installed" ? (
        <DocsRepoForm current={docs.data} onChanged={() => setTick(tick + 1)} />
      ) : (
        <Alert tone="warn" title="リポジトリを選べません">
          GitHub とつなぐと選べます
        </Alert>
      )}
    </Part>
  );
}

interface DocsRepoFormProps {
  /** 今の値と版 */
  current: DocsRepoValue;
  /** 保存した時と断られた時に呼ぶ。今の値を読み直す */
  onChanged: () => void;
}

/** 非公開のリポジトリから選んで保存する欄 */
function DocsRepoForm({ current, onChanged }: DocsRepoFormProps) {
  const api = useContext(ApiContext);
  const repos = useLoad(z.array(Repo), (a) => a.api.v1.github.repos.$get({ query: { limit: "100" } }));
  const [repo, setRepo] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();
  const [saved, setSaved] = useState<string>();
  const picked = repo ?? current.repo;
  const input = UpdateDocsRepoInput.safeParse({ repo: picked, version: current.version, reason: reason.trim() });

  const save = async () => {
    if (!api || !input.success) return;
    setBusy(true);
    setFailure(undefined);
    setSaved(undefined);
    const sent = await send(api, () => api.api.v1.devloop["docs-repo"].$put({ json: input.data }), { required: true });
    setBusy(false);
    // 断られた時も、ほかの所で変わった今の値を読み直す
    onChanged();
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    setSaved(input.data.repo);
    setReason("");
    setRepo(null);
  };

  return (
    <Stack gap={3}>
      {repos.state === "failed" ? <FailedAlert title="連携したリポジトリを読めませんでした" failure={repos} /> : null}
      <Field label="設計書のリポジトリ">
        <Select
          aria-label="設計書のリポジトリ"
          loading={repos.state === "loading"}
          value={picked}
          placeholder="選ぶ"
          options={repos.state === "ok" ? repos.data.filter((r) => r.private).map((r) => ({ value: r.fullName, label: r.fullName })) : []}
          onValueChange={(v) => {
            if (v !== null) setRepo(v);
          }}
        />
      </Field>
      <TextField label="選ぶ理由" value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
      <Stack direction="row" gap={2}>
        <Button loading={busy} disabled={!input.success || picked === current.repo} onClick={() => void save()}>
          設計書のリポジトリを保存する
        </Button>
      </Stack>
      {saved ? <Alert tone="success" live>{`${saved} を設計書のリポジトリにしました`}</Alert> : null}
      {failure ? <FailedAlert title="設計書のリポジトリを保存できませんでした" failure={failure} /> : null}
    </Stack>
  );
}
