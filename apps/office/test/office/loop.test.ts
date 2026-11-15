import { describe, expect, it } from "vitest";
import { type LoopClock, createLoop } from "../../src/screen/pages/office/loop.ts";

// 部屋を描く回し方。30fps に間引き、見えない間は止め、再開した時は止めていた分だけ動きの時刻をずらす。画面の 3.4

/**
 * 手で進める作り物の時計と requestAnimationFrame を作る
 * @returns 時計と、時刻を進めて頼まれた描画を呼ぶ関数
 */
function fakeClock() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, (t: number) => void>();
  const clock: LoopClock = {
    now: () => now,
    request: (cb) => {
      pending.set(next, cb);
      return next++;
    },
    cancel: (id) => pending.delete(id),
  };
  const tick = (t: number) => {
    now = t;
    const due = [...pending.values()];
    pending.clear();
    for (const cb of due) cb(t);
  };
  return { clock, tick, setNow: (t: number) => (now = t), pending: () => pending.size };
}

describe("描く回し方", () => {
  it("30fps に間引いて描く", () => {
    const { clock, tick } = fakeClock();
    const drawn: number[] = [];
    const loop = createLoop((t) => drawn.push(t), clock);
    loop.start();
    for (const t of [0, 16, 33, 50, 67, 83, 100]) tick(t);
    expect(drawn).toEqual([0, 33, 67, 100]);
  });

  it("止めていた間の分だけ動きの時刻をずらし、歩く動きが一瞬で終わらないようにする", () => {
    const { clock, tick, setNow } = fakeClock();
    const drawn: number[] = [];
    const loop = createLoop((t) => drawn.push(t), clock);
    loop.start();
    tick(0);
    tick(100);
    setNow(100);
    loop.pause();
    setNow(5100);
    loop.start();
    tick(5134);
    expect(drawn.at(-1)).toBe(134);
  });

  it("止めている間は描かず、次の描画も頼まない", () => {
    const { clock, tick, pending } = fakeClock();
    const drawn: number[] = [];
    const loop = createLoop((t) => drawn.push(t), clock);
    loop.start();
    tick(0);
    loop.pause();
    expect(pending()).toBe(0);
    tick(500);
    expect(drawn).toEqual([0]);
  });

  it("片付けた後は、始めても描かない", () => {
    const { clock, tick, pending } = fakeClock();
    const drawn: number[] = [];
    const loop = createLoop((t) => drawn.push(t), clock);
    loop.start();
    loop.stop();
    loop.start();
    tick(0);
    expect(pending()).toBe(0);
    expect(drawn).toEqual([]);
  });

  it("2 度始めても、描画を 2 重に頼まない", () => {
    const { clock, pending } = fakeClock();
    const loop = createLoop(() => undefined, clock);
    loop.start();
    loop.start();
    expect(pending()).toBe(1);
  });
});
