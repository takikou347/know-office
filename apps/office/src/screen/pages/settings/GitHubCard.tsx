// 設定の画面の GitHub。ボタン 1 つで App を作って入れ、連携したリポジトリを読み、ルールセットを掛け直す (GitHub の連携の 3.1 と 3.3)
import { GitHubLink, GitHubManifest, GitHubRulesApplied, Repo } from "@know-office/core";
import { Alert, Button, Card, List, Status } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";
import { type Failed, FailedAlert, send, useLoad } from "../../parts/load.tsx";

/** 連携の今ごとの、札の文と色 */
const LINK_STATUS: Record<GitHubLink["state"], { kind: "success" | "pending" | "warn"; label: string }> = {
  none: { kind: "warn", label: "連携していない" },
  app_created: { kind: "pending", label: "インストールする前" },
  installed: { kind: "success", label: "連携済み" },
};

/**
 * GitHub の画面へ移る。manifest があれば App を作る画面へフォームで送り、無ければインストール先へ移る
 * @param doc 今の文書
 * @param target connect の返した移り先
 */
export function goToGitHub(doc: Document, target: GitHubManifest): void {
  if (target.manifest === null) {
    doc.defaultView?.location.assign(target.action);
    return;
  }
  // GitHub の App の manifest の流れは、manifest を form の POST で受ける
  const form = doc.createElement("form");
  form.method = "post";
  form.action = target.action;
  const field = doc.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(target.manifest);
  form.append(field);
  doc.body.append(form);
  form.submit();
}

/** GitHub のカード。未連携、インストールする前、連携済みで出す物を変える */
export function GitHubCard() {
  const api = useContext(ApiContext);
  const link = useLoad(GitHubLink, (a) => a.api.v1.github.link.$get());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed>();

  const start = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    const sent = await send(api, () => api.api.v1.github.connect.$post(), { required: true });
    if (!sent.ok) {
      setBusy(false);
      setFailure(sent.failure);
      return;
    }
    const target = z.object({ data: GitHubManifest }).loose().safeParse(await sent.res.json());
    if (!target.success) {
      setBusy(false);
      setFailure({ code: "malformed", traceId: null });
      return;
    }
    goToGitHub(document, target.data.data);
  };

  if (link.state === "loading") return <p role="status">GitHub との連携を読んでいます</p>;
  if (link.state === "failed") return <FailedAlert title="GitHub との連携を読めませんでした" failure={link} />;
  const status = LINK_STATUS[link.data.state];
  return (
    <Card
      titleSize="lg"
      actionsAlign="end"
      title="GitHub"
      headingLevel={2}
      badge={<Status kind={status.kind} label={status.label} />}
      actions={
        link.data.state === "installed" ? undefined : (
          <Button loading={busy} onClick={() => void start()}>
            {link.data.state === "none" ? "連携する" : "インストールする"}
          </Button>
        )
      }
    >
      {link.data.state === "none" ? <p>ボタン 1 つで know-office の GitHub App を作り、触らせるリポジトリに入れます。始める前にパスキーで確かめます</p> : null}
      {link.data.state === "app_created" ? <p>GitHub App を作りましたが、まだリポジトリに入れていません。インストールすると連携が終わります</p> : null}
      {link.data.state === "installed" ? <Linked /> : null}
      {failure ? <FailedAlert title="GitHub と連携を始められませんでした" failure={failure} /> : null}
    </Card>
  );
}

/** 連携済みの時の、リポジトリの並びとルールセットの掛け直し */
function Linked() {
  const api = useContext(ApiContext);
  const repos = useLoad(z.array(Repo), (a) => a.api.v1.github.repos.$get({ query: {} }));
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string[]>();
  const [failure, setFailure] = useState<Failed>();

  const apply = async () => {
    if (!api || busy) return;
    setBusy(true);
    setFailure(undefined);
    setApplied(undefined);
    const sent = await send(api, () => api.api.v1.github.rules.apply.$post(), { required: true });
    setBusy(false);
    if (!sent.ok) {
      setFailure(sent.failure);
      return;
    }
    const result = z.object({ data: GitHubRulesApplied }).loose().safeParse(await sent.res.json());
    if (result.success) setApplied(result.data.data.applied);
    else setFailure({ code: "malformed", traceId: null });
  };

  return (
    <>
      {repos.state === "loading" ? <p role="status">リポジトリを読んでいます</p> : null}
      {repos.state === "failed" ? <FailedAlert title="連携したリポジトリを読めませんでした" failure={repos} /> : null}
      {repos.state === "ok" && repos.data.length === 0 ? <p>連携したリポジトリはありません</p> : null}
      {repos.state === "ok" && repos.data.length > 0 ? (
        <List label="連携したリポジトリ" items={repos.data.map((r) => ({ id: r.fullName, title: r.fullName, meta: r.private ? "非公開" : "公開" }))} />
      ) : null}
      <p>main を守るルールセットは、ルールを変えた時に掛けます。GitHub の側で外された時は掛け直します。掛ける前にパスキーで確かめます</p>
      <Button variant="secondary" loading={busy} onClick={() => void apply()}>
        ルールセットを掛け直す
      </Button>
      {applied ? (
        <Alert tone="success" live>
          {applied.length === 0 ? "掛ける公開のリポジトリはありませんでした" : `${applied.join("、")} に掛けました`}
        </Alert>
      ) : null}
      {failure ? <FailedAlert title="ルールセットを掛け直せませんでした" failure={failure} /> : null}
    </>
  );
}
