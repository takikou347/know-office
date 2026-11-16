import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/screen/mock.ts";
import { createWorkFeed } from "../../src/screen/pages/office/feed.ts";

// 画面が持つ今のデータ (社員とタスク) の置き場。タスクの一覧と詳細もここから読み、オフィスはここの変わりから出来事を起こす。画面の全体の 3.2

const t2: Task = { id: "t2", staffId: "builder", title: "CodeEditor のページを足す", service: "knowidea-ui", state: "可待ち", diff: "diff --git a/x b/x" };

const initial = { staff: [{ id: "builder", state: "working" as const }], tasks: [t2] };

describe("画面のデータの置き場", () => {
  it("タスクの状態を変えると新しい写しになり、前の写しは変わらない", () => {
    const feed = createWorkFeed(initial);
    const before = feed.snapshot();
    feed.setTaskState("t2", "済");
    expect(before.tasks[0]?.state).toBe("可待ち");
    expect(feed.snapshot().tasks[0]?.state).toBe("済");
  });

  it("状態を変えても、一覧と詳細に要る項目 (サービス、変更) を保つ", () => {
    const feed = createWorkFeed(initial);
    feed.setTaskState("t2", "済");
    expect(feed.snapshot().tasks[0]).toEqual({ ...t2, state: "済" });
  });

  it("タスクを足すと後ろに並ぶ", () => {
    const feed = createWorkFeed(initial);
    feed.addTask({ id: "t9", staffId: "builder", title: "通知を作る", service: "office", state: "次" });
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

  it("オフィスが受け取るたびに、前に受け取った時からの違いを渡す。初めは置き場を作った時から", () => {
    const feed = createWorkFeed(initial);
    feed.setTaskState("t2", "済");
    const first = feed.take();
    expect(first.before.tasks[0]?.state).toBe("可待ち");
    expect(first.now.tasks[0]?.state).toBe("済");
    const second = feed.take();
    expect(second.before).toBe(first.now);
    expect(second.now).toBe(first.now);
  });
});
