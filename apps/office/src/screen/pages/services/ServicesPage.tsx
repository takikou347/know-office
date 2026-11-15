// アイデアとサービスの画面。段階ごとの案と、サービスの様子、記録、設定。仮のデータで、足した案は画面の中だけに残る
import { Badge, Button, EmptyState, List, ListDetail, Stack, Tabs } from "knowidea-ui";
import { useState } from "react";
import { ideas, serviceLog, stages } from "../../mock.ts";
import type { Navigate } from "../../parts/navigate.ts";
import { Part } from "../../parts/section.tsx";

export function ServicesPage({ pathname, navigate }: { pathname: string; navigate: Navigate }) {
  const id = pathname.split("/")[2];
  const [added, setAdded] = useState<string[]>([]);
  const selected = ideas.find((i) => i.id === id);
  const list = (
    <Stack gap={4}>
      {stages.map((stage) => {
        const here = ideas.filter((i) => i.stage === stage);
        const extra = stage === "アイデア" ? added : [];
        return (
          <Part key={stage} title={stage}>
            <List
              label={stage}
              items={[
                ...here.map((i) => ({ id: i.id, title: i.title, href: `/services/${i.id}`, meta: i.summary })),
                ...extra.map((t, n) => ({ id: `new-${n}`, title: t, meta: "足した案" })),
              ]}
              emptyText="まだ無い"
            />
          </Part>
        );
      })}
      <Button variant="secondary" onClick={() => setAdded((a) => [...a, `新しい案 ${a.length + 1}`])}>
        案を足す
      </Button>
    </Stack>
  );
  return (
    <ListDetail
      listLabel="アイデアとサービス"
      detailLabel="サービスの様子"
      showDetail={Boolean(selected)}
      onBack={() => navigate("/services")}
      backLabel="一覧へ戻る"
      list={list}
      detail={
        selected ? (
          <Stack gap={4}>
            <Stack direction="row" gap={2} align="center" wrap>
              <h2>{selected.title}</h2>
              <Badge>{selected.stage}</Badge>
            </Stack>
            <Tabs
              label={`${selected.title}の様子`}
              defaultValue="state"
              items={[
                { value: "state", label: "様子", content: <p>{selected.summary}</p> },
                {
                  value: "log",
                  label: "記録",
                  content: (
                    <List
                      label={`${selected.title}の記録`}
                      items={(serviceLog[selected.id] ?? []).map((l, n) => ({ id: String(n), title: l.text, meta: l.time }))}
                      emptyText="記録はまだ無い"
                    />
                  ),
                },
                {
                  value: "settings",
                  label: "設定",
                  content: (
                    <List
                      label={`${selected.title}だけの設定`}
                      items={selected.settings.map((t, n) => ({ id: String(n), title: t }))}
                      emptyText="このサービスだけの設定は無い"
                    />
                  ),
                },
              ]}
            />
          </Stack>
        ) : undefined
      }
      empty={<EmptyState title="サービスを選ぶ">選ぶと、その様子と記録と設定が出ます</EmptyState>}
    />
  );
}
