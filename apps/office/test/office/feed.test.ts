import { describe, expect, it, vi } from "vitest";
import { createWorkFeed } from "../../src/screen/pages/office/feed.ts";

// 画面が持つ今のデータ (社員とタスク) の置き場。オフィスはここの変わりから出来事を起こす。画面の 3.4

const initial = {
  staff: [{ id: "builder", state: "working" as const }],
  tasks: [{ id: "t2", staffId: "builder", title: "CodeEditor のページを足す", state: "可待ち" as const }],
};

describe("画面のデータの置き場", () => {
  it("タスクの状態を変えると新しい写しになり、前の写しは変わらない", () => {
    const feed = createWorkFeed(initial);
    const before = feed.snapshot();
    feed.setTaskState("t2", "済");
    expect(before.tasks[0]?.state).toBe("可待ち");
    expect(feed.snapshot().tasks[0]?.state).toBe("済");
  });

  it("タスクを足すと後ろに並ぶ", () => {
    const feed = createWorkFeed(initial);
    feed.addTask({ id: "t9", staffId: "builder", title: "通知を作る", state: "次" });
    expect(feed.snapshot().tasks.map((t) => t.id)).toEqual(["t2", "t9"]);
  });

  it("変わると知らせ、やめた後は知らせない", () => {
    const feed = createWorkFeed(initial);
    const heard = vi.fn<() => void>();
    const stop = feed.subscribe(heard);
    feed.setTaskState("t2", "今");
    stop();
    feed.setTaskState("t2", "可待ち");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("知らないタスクと同じ状態への変更は何も変えず、知らせない", () => {
    const feed = createWorkFeed(initial);
    const heard = vi.fn<() => void>();
    feed.subscribe(heard);
    const before = feed.snapshot();
    feed.setTaskState("nope", "済");
    feed.setTaskState("t2", "可待ち");
    expect(feed.snapshot()).toBe(before);
    expect(heard).not.toHaveBeenCalled();
  });

  it("オフィスが最後に見た写しを覚え、初めは置き場を作った時の写しにする", () => {
    const feed = createWorkFeed(initial);
    expect(feed.seen).toBe(initial);
    feed.setTaskState("t2", "済");
    feed.seen = feed.snapshot();
    expect(feed.seen.tasks[0]?.state).toBe("済");
  });
});
