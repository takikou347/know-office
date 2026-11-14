import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/screen/App.tsx";

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
    expect(renderToString(<App url="/nowhere" />)).toContain("可を待つ物");
  });

  it("社員と仕事は、道の問いで開くタブを決め、知らない値は会話にする", () => {
    expect(renderToString(<App url="/staff/builder?tab=attendance" />)).toContain("勤怠を読んでいます");
    expect(renderToString(<App url="/staff/builder?tab=nope" />)).toContain("作る役との会話");
  });
});
