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
});
