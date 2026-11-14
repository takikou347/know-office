import { describe, expect, it } from "vitest";
import { type ClickLike, routeOfClick } from "../src/screen/link.ts";

const here = { origin: "https://office.example", pathname: "/staff", search: "" };
const click = (href: string, more: Partial<ClickLike> = {}, attrs: Record<string, string> = {}): ClickLike => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...more,
  link: { href: new URL(href, here.origin).href, attr: (n) => attrs[n] ?? null },
});

describe("リンクの横取り", () => {
  it("同じ所の画面へのリンクは、道と問いと印を残して横取りする", () => {
    expect(routeOfClick(click("/staff/builder?tab=tasks#a"), here)).toBe("/staff/builder?tab=tasks#a");
  });

  it("キーを押しながら、中ボタン、既に止められた押しは横取りしない", () => {
    expect(routeOfClick(click("/records", { ctrlKey: true }), here)).toBeNull();
    expect(routeOfClick(click("/records", { metaKey: true }), here)).toBeNull();
    expect(routeOfClick(click("/records", { button: 1 }), here)).toBeNull();
    expect(routeOfClick(click("/records", { defaultPrevented: true }), here)).toBeNull();
  });

  it("別の所、入口の API、download、target、external は横取りしない", () => {
    expect(routeOfClick(click("https://github.com/"), here)).toBeNull();
    expect(routeOfClick(click("/api"), here)).toBeNull();
    expect(routeOfClick(click("/api/health"), here)).toBeNull();
    expect(routeOfClick(click("/records", {}, { download: "" }), here)).toBeNull();
    expect(routeOfClick(click("/records", {}, { target: "_blank" }), here)).toBeNull();
    expect(routeOfClick(click("/records", {}, { rel: "noopener external" }), here)).toBeNull();
  });

  it("同じ画面の中の印だけが変わるリンクは、ブラウザに任せる", () => {
    expect(routeOfClick(click("/staff#top"), here)).toBeNull();
  });
});
