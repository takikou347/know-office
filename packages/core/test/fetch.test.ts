// 外への fetch が決めた宛先だけに出る事を確かめる。API の決まりの 3.6 の 6
import { describe, expect, it } from "vitest";
import { allowedFetch, type Fetcher } from "../src/index.ts";

const seen: string[] = [];
const fetcher: Fetcher = (url) => {
  seen.push(url);
  return Promise.resolve(new Response("ok"));
};

describe("外への通信", () => {
  it("決めた宛先の下だけを呼ぶ", async () => {
    await allowedFetch(fetcher, "https://api.github.com/repos", ["https://api.github.com/"]);
    expect(seen).toContain("https://api.github.com/repos");
  });

  it.each(["https://api.github.com.evil.example/repos", "https://evil.example/https://api.github.com/", "http://api.github.com/repos"])("%s は呼ばずに断る", async (url) => {
    await expect(allowedFetch(fetcher, url, ["https://api.github.com/"])).rejects.toThrow("決めた宛先でない");
    expect(seen).not.toContain(url);
  });
});
