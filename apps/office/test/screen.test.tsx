import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/screen/App.tsx";
import { ApiContext, createApi } from "../src/screen/api.ts";
import { RecordBreakdown } from "../src/screen/pages/ledger/RecordBreakdown.tsx";
import { staffTabOf } from "../src/screen/pages/staff/StaffPage.tsx";

describe("画面", () => {
  it("入口の様子を受け取る前は、確かめている事を出す", () => {
    const html = renderToString(<App />);
    expect(html).toContain("know-office");
    expect(html).toContain("入口を確かめています");
  });

  it("入口の様子を受け取ったら、つながった事を出す", () => {
    const html = renderToString(<App health={{ ok: true, part: "gate" }} />);
    expect(html).toContain("入口とつながりました");
  });

  it("道に合わせて画面の題を出し、知らない道はダッシュボードにする", () => {
    expect(renderToString(<App url="/guard" />)).toContain("止めた記録");
    expect(renderToString(<App url="/more" />)).toContain("その他の画面");
    expect(renderToString(<App url="/nowhere" />)).toContain('<h1 class="ki-appbar__title">ダッシュボード</h1>');
    expect(renderToString(<App url="/nowhere" />)).toContain("承認を待つ物");
  });

  it("社員と仕事は、道の問いで開くタブを決め、知らない値は会話にする", () => {
    expect(staffTabOf("attendance")).toBe("attendance");
    expect(staffTabOf("tasks")).toBe("tasks");
    expect(staffTabOf("nope")).toBe("talk");
    expect(staffTabOf(null)).toBe("talk");
  });

  it("記録の内訳は、入口を呼ぶ口が無ければ、読んでいるままにせず読めなかった事を出す", () => {
    const html = renderToString(<App url="/records" />);
    expect(html).toContain("記録を読めませんでした");
    expect(html).not.toContain("記録を読んでいます");
  });

  it("セキュリティと設定は、入口を呼ぶ口が無ければ、仮のデータを出さず読めなかった事を出す", () => {
    const guard = renderToString(<App url="/guard" />);
    expect(guard).toContain("止めている物を読めませんでした");
    expect(guard).toContain("止めた記録を読めませんでした");
    expect(guard).toContain("基準を読めませんでした");
    const settings = renderToString(<App url="/settings" />);
    expect(settings).toContain("全体のルールを読めませんでした");
    expect(settings).toContain("セッションを読めませんでした");
    expect(settings).toContain("パスキーを読めませんでした");
  });

  it("記録の内訳は、読んでいる間を status で知らせる", () => {
    // 返事の来ない入口にして、読んでいる間の形を描く
    const api = createApi("http://gate.invalid", () => new Promise<Response>(() => undefined));
    const html = renderToString(
      <ApiContext value={api}>
        <RecordBreakdown />
      </ApiContext>,
    );
    expect(html).toMatch(/<p role="status"[^>]*>サービスごとの記録を読んでいます/);
  });
});
