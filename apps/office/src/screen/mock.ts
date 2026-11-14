// モックの仮のデータ。本物の記録につなぐまで、画面の形を確かめるために使う。値はすべて作り物
export interface Staff {
  id: string;
  role: string;
  model: string;
  state: "working" | "paused" | "stopped";
  now: string;
}

export interface Task {
  id: string;
  staffId: string;
  title: string;
  service: string;
  state: "今" | "可待ち" | "次" | "済";
  diff?: string;
}

export interface WorkEntry {
  start: string;
  end: string;
  task: string;
  minutes: number;
  service: string;
  result: string;
}

export const staff: Staff[] = [
  { id: "president", role: "社長", model: "Opus 5.5", state: "working", now: "来週の目標を仕事に分けている" },
  { id: "builder", role: "作る役", model: "Sonnet 5.5", state: "working", now: "勤怠の表の画面を作っている" },
  { id: "reviewer", role: "見る役", model: "Opus 5.5", state: "paused", now: "見る物を待っている" },
];

const editorDiff = `diff --git a/apps/docs/src/demos/code-editor.tsx b/apps/docs/src/demos/code-editor.tsx
--- a/apps/docs/src/demos/code-editor.tsx
+++ b/apps/docs/src/demos/code-editor.tsx
@@ -1,4 +1,6 @@
 import { CodeEditor } from "knowidea-ui/editor";
+import { useState } from "react";

 export function Basic() {
-  return <CodeEditor value="" />;
+  const [value, setValue] = useState("const a = 1;");
+  return <CodeEditor value={value} onChange={setValue} language="typescript" />;
 }
`;

export const tasks: Task[] = [
  { id: "t1", staffId: "builder", title: "勤怠の表の画面を作る", service: "office", state: "今" },
  { id: "t2", staffId: "builder", title: "CodeEditor のページを足す", service: "knowidea-ui", state: "可待ち", diff: editorDiff },
  { id: "t3", staffId: "builder", title: "DiffView の行番号を直す", service: "knowidea-ui", state: "済" },
  { id: "t4", staffId: "builder", title: "AppShell の その他 を足す", service: "knowidea-ui", state: "次" },
  { id: "t5", staffId: "president", title: "来週の目標を仕事に分ける", service: "office", state: "今" },
  { id: "t6", staffId: "reviewer", title: "CodeEditor のページを見る", service: "knowidea-ui", state: "次" },
];

export const workEntries: Record<string, WorkEntry[]> = {
  builder: [
    { start: "9:00", end: "10:40", task: "DiffView の行番号を直す", minutes: 100, service: "knowidea-ui", result: "PR を出した" },
    { start: "10:45", end: "13:20", task: "CodeEditor のページを足す", minutes: 155, service: "knowidea-ui", result: "可待ち" },
    { start: "13:30", end: "17:10", task: "勤怠の表の画面を作る", minutes: 220, service: "office", result: "経過を残した" },
  ],
  president: [
    { start: "9:00", end: "12:00", task: "来週の目標を仕事に分ける", minutes: 180, service: "office", result: "6 件に分けた" },
  ],
  reviewer: [
    { start: "9:00", end: "11:30", task: "DiffView の行番号を見る", minutes: 150, service: "knowidea-ui", result: "可" },
  ],
};

export const messages: Record<string, { id: string; from: "self" | "other"; author: string; time: string; body: string }[]> = {
  builder: [
    { id: "m1", from: "self", author: "オーナー", time: "2026-11-14T00:05:00Z", body: "勤怠は表で見たい。始めた時刻、終えた時刻、仕事の名前があればいい" },
    { id: "m2", from: "other", author: "作る役", time: "2026-11-14T00:06:00Z", body: "分かりました。仕事 1 件を 1 行にした表にします。掛かった時間とサービスは行を開くと出します" },
  ],
  president: [{ id: "m3", from: "other", author: "社長", time: "2026-11-14T00:00:00Z", body: "今週の目標を 6 件の仕事に分けました" }],
  reviewer: [],
};

export type Stage = "アイデア" | "選んだ" | "作る" | "運用";
export const stages: readonly Stage[] = ["アイデア", "選んだ", "作る", "運用"];

export const ideas: { id: string; title: string; stage: Stage; summary: string; settings: string[] }[] = [
  { id: "knowidea-ui", title: "knowidea-ui", stage: "運用", summary: "画面の部品。0.11.0 を npm に出している", settings: ["版を上げたら npm に出す", "部品を足したら 1 部品 1 ページ"] },
  { id: "know-office", title: "know-office", stage: "作る", summary: "AI 社員を管理するアプリ。モックを作っている", settings: ["勤務は 9:00 から 8 時間"] },
  { id: "video", title: "動画を作るサービス", stage: "アイデア", summary: "まだ案だけ", settings: [] },
];

export const serviceLog: Record<string, { time: string; text: string }[]> = {
  "knowidea-ui": [
    { time: "11/14 13:20", text: "CodeEditor のページを足す の可を待っている" },
    { time: "11/14 10:40", text: "DiffView の行番号を直した" },
  ],
  "know-office": [{ time: "11/14 17:10", text: "勤怠の表の画面の経過を残した" }],
  video: [],
};

export const stops = [
  { id: "x1", time: "10:12", target: "見る役", reason: "同じ道具の失敗が 5 回続いた", state: "再開した" },
  { id: "x2", time: "16:40", target: "作る役", reason: "1 時間の切符が切れても区切りが来ない", state: "止めている" },
];

export const guardRules = [
  "同じ道具の失敗が 5 回続いたら止める",
  "1 つの仕事は 1 時間の切符で動き、切れたら区切りを待って止める",
  "ルールの判断が 5 秒で返らなければ断る",
  "1 日のトークンが上限を超えそうなら止めて聞く",
];

export const lessons = [
  { id: "l1", text: "テストが同じ所で落ち続けたら、直す前に落ちる理由を 1 行書く", from: "x1" },
];

export const usage = [
  { id: "president", who: "社長", tokens: 412_000, cost: 1.9 },
  { id: "builder", who: "作る役", tokens: 1_830_000, cost: 6.2 },
  { id: "reviewer", who: "見る役", tokens: 960_000, cost: 3.3 },
];

export const monthCost = { used: 11.4, budget: 15 };

export const notices = [
  { id: "n1", time: "16:40", text: "作る役を止めた。1 時間の切符が切れても区切りが来ない" },
  { id: "n2", time: "13:20", text: "CodeEditor のページを足す が可を待っている" },
];

export const flows: Record<string, { id: string; time: string; title: string; text: string }[]> = {
  t2: [
    { id: "f3", time: "13:20", title: "渡した", text: "見る役とオーナーに可を頼んだ" },
    { id: "f2", time: "12:10", title: "試した", text: "テストとページの検査が通った" },
    { id: "f1", time: "10:45", title: "始めた", text: "社長から仕事を受けた" },
  ],
};

export const sessions = [
  { id: "s1", device: "Mac の Chrome", last: "今", current: true },
  { id: "s2", device: "iPhone の Safari", last: "11/13 22:10", current: false },
];

export const extensions = [
  { id: "career", title: "職務経歴をまとめる", installed: false },
];
