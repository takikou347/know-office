// Cloudflare の月の費用の見込み。Workers の有料プランの定額と、ワークスペースのコンテナが動いた時間から出す。費用は百万分の 1 ドルで出す (画面の全体の画面の一覧)
// 単価と含まれる量の出典: https://developers.cloudflare.com/containers/platform/pricing/ と https://developers.cloudflare.com/workers/platform/pricing/ (2026-11 に確かめた)

/** Workers の有料プランの月額 (百万分の 1 ドル) */
export const WORKERS_PAID_MICRO_USD = 5_000_000;

/** ワークスペースのコンテナの instance_type basic の大きさ。vCPU は 1/4、メモリ 1 GiB、ディスク 4 GB */
const BASIC = { vcpu: 0.25, memoryGib: 1, diskGb: 4 } as const;

/** 有料プランに含まれる月の量 (秒) */
const INCLUDED = { memoryGibSeconds: 25 * 3600, vcpuSeconds: 375 * 60, diskGbSeconds: 200 * 3600 } as const;

/** 含まれる量を超えた分の 1 秒あたりの単価。百万分の 1 ドルの千分の 1 で持ち、小数の誤差を出さない */
const PRICE = { memoryGibSecond: 2500, vcpuSecond: 20_000, diskGbSecond: 70 } as const;

/**
 * 含まれる量を超えた分
 * @param used 使った量
 * @param included 含まれる量
 * @returns 超えた量。超えなければ 0
 */
const over = (used: number, included: number) => Math.max(0, used - included);

/**
 * Cloudflare の 1 か月の費用の見込みを出す。CPU は使った分だけ掛かるが、測れないので割り当てた vCPU をすべて使った上限で数える。外への通信は含まれる量の内として数えない
 * @param containerMs その月にワークスペースのコンテナが動いた時間の和 (ミリ秒)
 * @returns 百万分の 1 ドル。端数は切り上げる
 */
export function cloudflareMonthMicroUsd(containerMs: number): number {
  const seconds = containerMs / 1000;
  const milli =
    over(seconds * BASIC.memoryGib, INCLUDED.memoryGibSeconds) * PRICE.memoryGibSecond +
    over(seconds * BASIC.vcpu, INCLUDED.vcpuSeconds) * PRICE.vcpuSecond +
    over(seconds * BASIC.diskGb, INCLUDED.diskGbSeconds) * PRICE.diskGbSecond;
  return WORKERS_PAID_MICRO_USD + Math.ceil(Math.round(milli) / 1000);
}
