// 設定の画面の設計書のリポジトリ。触れるリポジトリのうち非公開の物から 1 つ選ぶ。試作に進めた案の設計書はここに置く (開発の回し方の 3.2)
import { DocsRepo as DocsRepoValue, GitHubLink, Repo, UpdateDocsRepoInput } from "@know-office/core";
import { Alert, Field, Select } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { FailedAlert, send, useLoad } from "../../parts/load.tsx";
import { SettingCard } from "../../parts/setting-card.tsx";

const TITLE = "設計書のリポジトリ";

/** 設計書のリポジトリのカード。今の値を読み、連携していれば編集で非公開のリポジトリから選び直して保存する */
export function DocsRepo() {
  const api = useContext(ApiContext);
  const [tick, setTick] = useState(0);
  const docs = useLoad(DocsRepoValue, (a) => a.api.v1.devloop["docs-repo"].$get(), tick);
  const link = useLoad(GitHubLink, (a) => a.api.v1.github.link.$get());
  const [repo, setRepo] = useState<string | null>(null);
  if (docs.state === "loading" || link.state === "loading") return <p role="status">設計書のリポジトリを読んでいます</p>;
  if (docs.state === "failed") return <FailedAlert title="設計書のリポジトリを読めませんでした" failure={docs} />;
  if (link.state === "failed") return <FailedAlert title="GitHub との連携を読めませんでした" failure={link} />;

  const current = docs.data;
  const picked = repo ?? current.repo;
  const save = async (reason: string) => {
    const input = UpdateDocsRepoInput.safeParse({ repo: picked, version: current.version, reason });
    if (!api || !input.success) return { ok: false as const, failure: { code: "validation_failed", traceId: null } };
    const sent = await send(api, () => api.api.v1.devloop["docs-repo"].$put({ json: input.data }), { required: true });
    // 断られた時も、ほかの所で変わった今の値を読み直す
    setTick((t) => t + 1);
    if (!sent.ok) return sent;
    setRepo(null);
    return { ok: true as const, done: `${input.data.repo} を設計書のリポジトリにしました` };
  };

  return (
    <SettingCard
      title={TITLE}
      headingLevel={2}
      description="試作に進めた案の設計書を、この非公開のリポジトリの services/<名前>/ に置きます"
      current={current.repo ?? "まだ選んでいません。選ぶまで案を試作に進められません"}
      editor={
        <>
          <DocsRepoPicker value={picked} onChange={setRepo} />
          <p>サービスのリポジトリは選べません。選ぶ前にパスキーで確かめます</p>
        </>
      }
      ready={picked !== null && picked !== current.repo}
      save={save}
      refusedTitle={() => "設計書のリポジトリを保存できませんでした"}
      onCancel={() => setRepo(null)}
      locked={
        link.data.state === "installed" ? undefined : (
          <Alert tone="warn" title="リポジトリを選べません">
            GitHub とつなぐと選べます
          </Alert>
        )
      }
    />
  );
}

interface DocsRepoPickerProps {
  /** 選んでいるリポジトリ */
  value: string | null;
  /** 選び直した時に呼ぶ */
  onChange: (repo: string) => void;
}

/** 連携したリポジトリのうち非公開の物から 1 つ選ぶ。編集を押した時に読む */
function DocsRepoPicker({ value, onChange }: DocsRepoPickerProps) {
  const repos = useLoad(z.array(Repo), (a) => a.api.v1.github.repos.$get({ query: { limit: "100" } }));
  return (
    <>
      {repos.state === "failed" ? <FailedAlert title="連携したリポジトリを読めませんでした" failure={repos} /> : null}
      <Field label={TITLE}>
        <Select
          aria-label={TITLE}
          loading={repos.state === "loading"}
          value={value}
          placeholder="選ぶ"
          options={repos.state === "ok" ? repos.data.filter((r) => r.private).map((r) => ({ value: r.fullName, label: r.fullName })) : []}
          onValueChange={(v) => {
            if (v !== null) onChange(v);
          }}
        />
      </Field>
    </>
  );
}
