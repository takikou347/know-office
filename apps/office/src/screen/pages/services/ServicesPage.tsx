// アイデアとサービスの画面。段階ごとの一覧と案を足す欄、選んだサービスの詳細 (サービスと拡張の 3.1 から 3.3)
import { ServiceCard, ServiceStage } from "@know-office/core";
import { EmptyState, List, ListDetail, Stack } from "knowidea-ui";
import { useState } from "react";
import { z } from "zod";
import { FailedAlert, useLoad } from "../../parts/load.tsx";
import type { Navigate } from "../../parts/navigate.ts";
import { Part } from "../../parts/section.tsx";
import { IdeaForm } from "./IdeaForm.tsx";
import { KIND_LABEL, STAGE_LABEL } from "./labels.ts";
import { ServiceView } from "./ServiceView.tsx";

export interface ServicesPageProps {
  /** 今の道。`/services/<サービス ID>` なら詳細を出す */
  pathname: string;
  /** 道を移す */
  navigate: Navigate;
}

/** アイデアとサービスの画面 */
export function ServicesPage({ pathname, navigate }: ServicesPageProps) {
  const id = z.uuid().safeParse(pathname.split("/")[2]);
  const [tick, setTick] = useState(0);
  const loaded = useLoad(z.array(ServiceCard), (a) => a.api.v1.services.$get({ query: { limit: "100" } }), tick);
  const reload = () => setTick((t) => t + 1);

  let lists = <p role="status">サービスを読んでいます</p>;
  if (loaded.state === "failed") lists = <FailedAlert title="サービスを読めませんでした" failure={loaded} />;
  if (loaded.state === "ok") {
    lists = (
      <>
        {ServiceStage.options.map((stage) => (
          <Part key={stage} title={STAGE_LABEL[stage]}>
            <List
              label={STAGE_LABEL[stage]}
              items={loaded.data.filter((s) => s.stage === stage).map((s) => ({ id: s.id, title: s.name, href: `/services/${s.id}`, meta: [KIND_LABEL[s.kind], s.repo].filter(Boolean).join("、") }))}
              emptyText="まだ無い"
            />
          </Part>
        ))}
      </>
    );
  }
  const list = (
    <Stack gap={4}>
      <Part title="案を足す">
        <IdeaForm
          onAdded={(card) => {
            reload();
            navigate(`/services/${card.id}`);
          }}
        />
      </Part>
      {lists}
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
