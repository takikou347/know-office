// アイデアとサービスの画面。左に段階のフィルターと追加と一覧、右に選んだサービスの詳細 (サービスと拡張の 3.1 から 3.3)
import { labelOf, optionsOf } from "@know-office/core/master/master";
import { SERVICE_KINDS } from "@know-office/core/master/service-kinds";
import { SERVICE_STAGES } from "@know-office/core/master/service-stages";
import { ServiceCard, ServiceStage } from "@know-office/core";
import { EmptyState, Field, List, ListDetail, Select, Stack } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import type { Navigate } from "../../parts/navigate.ts";
import { IdeaForm } from "./IdeaForm.tsx";
import { ServiceView } from "./ServiceView.tsx";

export interface ServicesPageProps {
  /** 今の道。`/services/<サービス ID>` なら詳細を出す */
  pathname: string;
  /** 道を移す */
  navigate: Navigate;
}

/** 段階のフィルターの、すべてを出す値 */
const ALL = "all";

/** アイデアとサービスの画面 */
export function ServicesPage({ pathname, navigate }: ServicesPageProps) {
  const id = z.uuid().safeParse(pathname.split("/")[2]);
  const [tick, setTick] = useState(0);
  const [stage, setStage] = useState<ServiceStage | typeof ALL>(ALL);
  const loaded = useLoad(z.array(ServiceCard), (a) => a.api.v1.services.$get({ query: { limit: "100" } }), tick);
  const reload = () => setTick((t) => t + 1);
  const all = loaded.state === "ok" ? loaded.data : [];
  const shown = stage === ALL ? all : all.filter((c) => c.stage === stage);

  const list = (
    <Stack gap={3}>
      <Stack direction="row" gap={2} align="end" justify="between" wrap>
        <Field label="段階">
          <Select
            aria-label="段階"
            value={stage}
            options={[{ value: ALL, label: "すべて" }, ...optionsOf(SERVICE_STAGES)]}
            onValueChange={(v) => {
              const next = ServiceStage.safeParse(v);
              setStage(next.success ? next.data : ALL);
            }}
          />
        </Field>
        <IdeaForm
          onAdded={(card) => {
            setStage(ALL);
            reload();
            navigate(`/services/${card.id}`);
          }}
        />
      </Stack>
      {loaded.state === "failed" ? (
        <FailedAlert title="サービスを読めませんでした" failure={loaded} />
      ) : (
        <List
          label="アイデアとサービス"
          state={loaded.state === "loading" ? "loading" : "ready"}
          loadingText="サービスを読んでいます"
          summary={loaded.state === "ok" ? `${String(shown.length)} 件` : undefined}
          items={shown.map((s) => ({ id: s.id, title: s.name, href: `/services/${s.id}`, meta: [labelOf(SERVICE_STAGES, s.stage), labelOf(SERVICE_KINDS, s.kind), s.repo].filter(Boolean).join("、") }))}
          emptyText="データがありません"
        />
      )}
    </Stack>
  );
  return (
    <ListDetail
      listLabel="アイデアとサービス"
      detailLabel="サービスの様子"
      showDetail={id.success}
      onBack={() => navigate("/services")}
      backLabel="一覧へ戻る"
      list={list}
      detail={id.success ? <ServiceView key={id.data} serviceId={id.data} tick={tick} onChanged={reload} /> : undefined}
      empty={<EmptyState title="サービスを選ぶ">選ぶと、その様子と元の案と記録と設定が出ます</EmptyState>}
    />
  );
}
