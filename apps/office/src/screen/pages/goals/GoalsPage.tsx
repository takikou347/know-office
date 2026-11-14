// 目的と組織図の画面。目的からタスクまでの木と進み具合、組織図、役目の説明文を入口から読み、説明文を直す (タスクとレビューの 3.1)
import type { NodeStatus, NodeTree, OrgStaff } from "@know-office/core";
import { StaffId } from "@know-office/core";
import { Alert, Badge, Button, Card, Field, Progress, Stack, Textarea } from "knowidea-ui";
import { type FormEvent, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { z } from "zod";
import { ApiContext } from "../../api.ts";

const Failure = z.object({ code: z.string(), traceId: z.string() }).loose();

type Failed = { state: "failed"; code: string; traceId: string | null };
type Loaded<T> = { state: "loading" } | { state: "ok"; data: T } | Failed;

const STATUS_LABEL: Record<NodeStatus, string> = {
  todo: "次",
  doing: "今",
  review: "確かめ待ち",
  done: "済",
  stopped: "止めた",
  waiting_owner: "オーナーの答え待ち",
  dropped: "見送り",
};

const KIND_LABEL = { purpose: "目的", goal: "目標", project: "プロジェクト", task: "タスク" } as const;

/**
 * 失敗の返事を code と traceId に直す
 * @param res 返事
 * @returns 読めなかった
 */
async function failureOf(res: Response): Promise<Failed> {
  // 返事は code で分け、不具合を伝えられるよう traceId を添える
  const body = Failure.safeParse(await res.json().catch(() => null));
  return body.success ? { state: "failed", code: body.data.code, traceId: body.data.traceId } : { state: "failed", code: String(res.status), traceId: null };
}

/**
 * 入口から読み、読み直す口を返す
 * @param load 読む関数。入口を呼ぶ口が無ければ呼ばない
 * @returns 読んだ物と読み直す関数
 */
function useLoad<T>(load: () => Promise<Loaded<T>> | null): [Loaded<T>, () => void] {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  const run = useCallback(() => {
    let live = true;
    void load()
      ?.catch((): Loaded<T> => ({ state: "failed", code: "network", traceId: null }))
      .then((value) => {
        if (live) setLoaded(value);
      });
    return () => {
      live = false;
    };
  }, [load]);
  useEffect(run, [run]);
  return [
    loaded,
    useCallback(() => {
      run();
    }, [run]),
  ];
}

/**
 * 読めなかった事を伝える帯
 * @param props 何を読めなかったかと理由
 * @param props.what 読めなかった物
 * @param props.failed 理由
 * @returns 失敗の帯
 */
function LoadFailed({ what, failed }: { what: string; failed: Failed }) {
  return (
    <Alert tone="error" title={`${what}を読めませんでした`}>
      {failed.code === "network" ? "入口につながりません。" : `理由: ${failed.code}。`}
      {failed.traceId ? ` 問い合わせの番号: ${failed.traceId}` : null}
    </Alert>
  );
}

/**
 * 区切りの見出しと中身
 * @param props 見出しと中身
 * @param props.title 見出し
 * @param props.children 中身
 * @returns 区切り
 */
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack as="section" gap={3}>
      <h2>{title}</h2>
      {children}
    </Stack>
  );
}

/**
 * プロジェクトとタスクの入れ子の一覧
 * @param props 子
 * @param props.items 子の並び
 * @returns 入れ子の一覧
 */
function Branches({ items }: { items: NodeTree[] }) {
  if (items.length === 0) return <p>まだ分けていない</p>;
  return (
    <ul>
      {items.map((n) => (
        <li key={n.id}>
          {KIND_LABEL[n.kind]}: {n.title}{" "}
          {n.kind === "task" ? <Badge>{STATUS_LABEL[n.status]}</Badge> : <span>({Math.round(n.progress * 100)}%)</span>}
          {n.children.length > 0 ? <Branches items={n.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * 根 1 つ分の木。目的は区切り、目標はカード、その下を入れ子の一覧で出す
 * @param props 根
 * @param props.root 目的か、受け付けのプロジェクト
 * @returns 根の木
 */
function Root({ root }: { root: NodeTree }) {
  const goals = root.kind === "purpose" ? root.children : [root];
  return (
    <Part title={`${KIND_LABEL[root.kind]}: ${root.title}`}>
      <Progress label={`${root.title}の進み具合`} value={Math.round(root.progress * 100)} max={100} />
      {goals.length === 0 ? <p>目標はまだ無い</p> : null}
      {goals.map((g) => (
        <Card key={g.id} title={`${KIND_LABEL[g.kind]}: ${g.title}`}>
          <Stack gap={2}>
            {g.kind === root.kind ? null : <Progress label={`${g.title}の進み具合`} value={Math.round(g.progress * 100)} max={100} />}
            <Branches items={g.children} />
          </Stack>
        </Card>
      ))}
    </Part>
  );
}

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
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!api || busy) return;
    setBusy(true);
    const res = await api.api.v1.staff[":staffId"].prompt.$put({ param: { staffId: person.id }, json: { version: person.promptVersion, body } }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setError(null);
      saved();
      return;
    }
    const failed = res ? await failureOf(res) : null;
    setError(failed?.code === "conflict" ? "ほかで直されていました。読み直してから直してください" : `直せませんでした。理由: ${failed?.code ?? "network"}`);
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
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
          <strong>{person.role}</strong> ({person.model}、説明文の版 {person.promptVersion})
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

/**
 * 目的と組織図の画面の中身
 * @returns 木と組織図
 */
export function GoalsPage() {
  const api = useContext(ApiContext);
  const loadTrees = useCallback(
    () =>
      api
        ? api.api.v1.nodes.$get({ query: { scope: "office" } }).then(async (res): Promise<Loaded<NodeTree[]>> => (res.ok ? { state: "ok", data: (await res.json()).data } : failureOf(res)))
        : null,
    [api],
  );
  const loadOrg = useCallback(
    () => (api ? api.api.v1.org.$get({ query: {} }).then(async (res): Promise<Loaded<OrgStaff[]>> => (res.ok ? { state: "ok", data: (await res.json()).data } : failureOf(res))) : null),
    [api],
  );
  const [trees] = useLoad(loadTrees);
  const [org, reloadOrg] = useLoad(loadOrg);
  const top = org.state === "ok" ? org.data.filter((p) => p.bossId === null || !StaffId.safeParse(p.bossId).success) : [];
  return (
    <>
      {trees.state === "loading" ? <p>目的からタスクまでを読んでいます</p> : null}
      {trees.state === "failed" ? <LoadFailed what="目的からタスクまで" failed={trees} /> : null}
      {trees.state === "ok" && trees.data.length === 0 ? <p>目的はまだ無い</p> : null}
      {trees.state === "ok" ? trees.data.map((root) => <Root key={root.id} root={root} />) : null}
      <Part title="組織図と役目">
        {org.state === "loading" ? <p>組織図を読んでいます</p> : null}
        {org.state === "failed" ? <LoadFailed what="組織図" failed={org} /> : null}
        {org.state === "ok" ? (
          <ul>
            {top.map((p) => (
              <Person key={p.id} person={p} people={org.data} reload={reloadOrg} />
            ))}
          </ul>
        ) : null}
      </Part>
    </>
  );
}
