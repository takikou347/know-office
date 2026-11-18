// 決めていない承認を読む。ダッシュボードの件数と先頭の数件、決める画面の 409 の見分けに使う (タスクとレビューの 3.4)
import { Approval } from "@know-office/core";
import { z } from "zod";
import type { Api } from "../../api.ts";
import { type Loaded, useLoad } from "../../parts/load.tsx";

/** 1 度に読む件数の上限。入口の limit の上限と同じ */
export const PENDING_LIMIT = 100;

/** 何度まで続きを読むか。決めていない承認がこれより多い時は、残っている事にする */
const MAX_PAGES = 10;

const Page = z.object({ data: z.array(Approval), meta: z.object({ next: z.string().nullable().optional() }).loose() });

/**
 * その承認がまだ決めていない物の中にあるかを読む。読めなければ、ある事にする (先に決まったと誤って言わない)
 * @param api 入口を呼ぶ口
 * @param id 承認 ID
 * @returns まだ決めていなければ true
 */
export async function stillPending(api: Api, id: string): Promise<boolean> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query: { status: "pending"; limit: string; cursor?: string } = { status: "pending", limit: String(PENDING_LIMIT), ...(cursor === null ? {} : { cursor }) };
    const res = await api.api.v1.approvals.$get({ query }).catch(() => null);
    if (!res?.ok) return true;
    const read = Page.safeParse(await res.json().catch(() => null));
    if (!read.success) return true;
    if (read.data.data.some((a) => a.id === id)) return true;
    cursor = read.data.meta.next ?? null;
    if (cursor === null) return false;
  }
  return true;
}

/**
 * 決めていない承認を古い順に 100 件まで読む。ダッシュボードの件数と先頭の数件に使う
 * @returns 読んでいる、読めた、読めなかった
 */
export function usePendingApprovals(): Loaded<Approval[]> {
  return useLoad(z.array(Approval), (a) => a.api.v1.approvals.$get({ query: { status: "pending", limit: String(PENDING_LIMIT) } }));
}
