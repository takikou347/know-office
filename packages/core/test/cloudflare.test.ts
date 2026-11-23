// Cloudflare の月の費用の見込みを、有料プランの定額とワークスペースの稼働時間から出す事を確かめる (画面の全体の画面の一覧)
import { describe, expect, it } from "vitest";
import { cloudflareMonthMicroUsd } from "../src/cloudflare.ts";

const HOUR_MS = 3_600_000;

describe("画面の一覧", () => {
  it("費用を月ごとと累計で見る", () => {
    // 稼働の無い月も有料プランの 5 ドルは掛かる
    expect(cloudflareMonthMicroUsd(0)).toBe(5_000_000);
    // 含まれる量 (メモリ 25 GiB 時、CPU 375 vCPU 分、ディスク 200 GB 時) の内なら定額だけ。basic は 1 GiB、1/4 vCPU、4 GB なので 25 時間までは CPU も含まれる量の内
    expect(cloudflareMonthMicroUsd(25 * HOUR_MS)).toBe(5_000_000);
    // 社員 3 人が 8 時間を 22 日 (528 時間) 動かすと、定額にメモリ、CPU、ディスクの超えた分が乗る
    // メモリ (528 - 25) GiB 時 x 3600 x 0.0000025 = 4.527、CPU (528 x 15 - 375) vCPU 分 x 60 x 0.00002 = 9.054、ディスク (2112 - 200) GB 時 x 3600 x 0.00000007 = 0.48182
    expect(cloudflareMonthMicroUsd(528 * HOUR_MS)).toBe(5_000_000 + 4_527_000 + 9_054_000 + 481_824);
  });
});
