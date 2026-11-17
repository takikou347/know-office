// オフィスの出来事の置き場。配信の印をため、オフィスを開いた時に前に開いた時からの出来事を渡す。読み込んだ状態は出来事にしない。画面の全体の 3.2
import type { LiveEvent } from "@know-office/core";
import { describe, expect, it, vi } from "vitest";
import { createOfficeNews } from "../../src/screen/pages/office/news.ts";

const NODE = "019a7b00-0000-7000-8000-0000000000a1";
const staffMark = (id: "president" | "builder" | "reviewer", state: "off" | "working" | "wrapping" | "waiting" | "stopped"): LiveEvent => ({ type: "staff", staff: { id, state, nodeId: null } });
const workMark = (title: string): LiveEvent => ({ type: "work", work: { nodeId: NODE, title, action: "approve", from: "reviewer", to: "builder" } });

describe("オフィスの部屋", () => {
  it("初めて読み込んだ時と読み直した時の状態は出来事にしない", () => {
    const news = createOfficeNews();
    news.know([{ id: "builder", state: "working" }]);
    news.know([{ id: "builder", state: "off" }]);
    // 前の状態の分からない社員の印は、覚えるだけにする
    news.hear(staffMark("reviewer", "working"));
    expect(news.take().events).toEqual([]);
  });
});

describe("出来事の置き場", () => {
  it("知っている社員の部屋の様子が変わった時だけ、状態の出来事にする", () => {
    const news = createOfficeNews();
    news.know([{ id: "builder", state: "working" }]);
    // 片付けは働く姿のままなので出来事にしない
    news.hear(staffMark("builder", "wrapping"));
    news.hear(staffMark("builder", "off"));
    expect(news.take().events).toEqual([{ kind: "state", staffId: "builder", from: "working", to: "off" }]);
  });

  it("前に受け取った時からの出来事を、1 つ目の前の状態と一緒に渡し、渡した後は空にする", () => {
    const news = createOfficeNews();
    news.know([{ id: "builder", state: "working" }]);
    news.hear(workMark("A"));
    news.hear(staffMark("builder", "waiting"));
    const taken = news.take();
    expect(taken.before).toEqual({ staff: [{ id: "builder", state: "working" }] });
    expect(taken.events.map((e) => e.kind)).toEqual(["approve", "state"]);
    expect(news.take()).toEqual({ before: { staff: [{ id: "builder", state: "waiting" }] }, events: [] });
  });

  it("ためる上限を超えた出来事は古い順に捨てる", () => {
    const news = createOfficeNews(2);
    for (const title of ["A", "B", "C"]) news.hear(workMark(title));
    expect(news.take().events.map((e) => (e.kind === "approve" ? e.title : ""))).toEqual(["B", "C"]);
  });

  it("出来事がたまると知らせ、ほかの印では知らせない", () => {
    const news = createOfficeNews();
    const heard = vi.fn<() => void>();
    const stop = news.subscribe(heard);
    news.hear({ type: "node", node: { id: NODE } });
    news.hear(workMark("A"));
    stop();
    news.hear(workMark("B"));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
