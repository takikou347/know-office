// 入口、社員の状態、作業場、画面が共に使う型と判断を置く

export const PARTS = ["gate", "workspace"] as const;

export type Part = (typeof PARTS)[number];

export type Health = { ok: true; part: Part };

export function health(part: Part): Health {
  return { ok: true, part };
}
