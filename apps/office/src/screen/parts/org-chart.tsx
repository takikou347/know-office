// 組織図と役目の説明文。上司から部下へ入れ子で並べ、説明文を直す (タスクとレビューの 3.1、API の org)。社員の画面が置く
import { OrgStaff } from "@know-office/core";
import { labelOf } from "@know-office/core/master/master";
import { MODELS } from "@know-office/core/master/models";
import { Button, Field, Stack, Textarea } from "knowidea-ui";
import { useContext, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../api.ts";
import { FailedAlert, send, useLoad } from "./load.tsx";

/**
 * 役目の説明文を直す欄
 * @param props 社員と、直した後に読み直す関数
 * @param props.person 社員
 * @param props.saved 直した後に呼ぶ
 * @returns 説明文を直す欄
 */
function PromptForm({ person, saved }: { person: OrgStaff; saved: () => void }) {
  const api = useContext(ApiContext);
  const [body, setBody] = useState(person.prompt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    const sent = await send(api, () => api.api.v1.staff[":staffId"].prompt.$put({ param: { staffId: person.id }, json: { version: person.promptVersion, body } }));
    setBusy(false);
    if (sent.ok) {
      setError(null);
      saved();
      return;
    }
    setError(sent.failure.code === "conflict" ? "ほかで直されていました。読み直してから直してください" : `直せませんでした。理由: ${sent.failure.code}`);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack gap={2}>
        <Field label={`${person.role}の役目の説明文`} hint="次のタスクから使われます" error={error ?? undefined}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
        </Field>
        <div>
          <Button type="submit" loading={busy}>
            説明文を保存する
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * 組織図の 1 人と部下
 * @param props 社員、全員、読み直す関数
 * @param props.person 社員
 * @param props.people 全員
 * @param props.reload 読み直す
 * @returns 1 人と部下の入れ子
 */
function Person({ person, people, reload }: { person: OrgStaff; people: OrgStaff[]; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const reports = people.filter((p) => p.bossId === person.id);
  return (
    <li>
      <Stack gap={2}>
        <p>
          <strong>{person.role}</strong> ({labelOf(MODELS, person.model)}、説明文の版 {person.promptVersion})
        </p>
        <p>{person.prompt}</p>
        {editing ? (
          <PromptForm
            person={person}
            saved={() => {
              setEditing(false);
              reload();
            }}
          />
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {person.role}の説明文を直す
            </Button>
          </div>
        )}
      </Stack>
      {reports.length > 0 ? (
        <ul>
          {reports.map((r) => (
            <Person key={r.id} person={r} people={people} reload={reload} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 組織図。上司のいない社員から、部下を入れ子で並べる */
export function OrgChart() {
  const [tick, setTick] = useState(0);
  const org = useLoad(z.array(OrgStaff), (a) => a.api.v1.org.$get({ query: {} }), tick);
  if (org.state === "loading") return <p role="status">組織図を読んでいます</p>;
  if (org.state === "failed") return <FailedAlert title="組織図を読めませんでした" failure={org} />;
  const ids = new Set<string>(org.data.map((p) => p.id));
  const top = org.data.filter((p) => p.bossId === null || !ids.has(p.bossId));
  return (
    <ul aria-label="組織図">
      {top.map((p) => (
        <Person key={p.id} person={p} people={org.data} reload={() => setTick((t) => t + 1)} />
      ))}
    </ul>
  );
}
