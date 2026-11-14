// 外の宛先を決める所を確かめる。本番の値では代わりの物を使わない。ログインと記録の 3.9
import { describe, expect, it } from "vitest";
import { endpoints } from "../../src/gate/endpoints.ts";

const REAL = {
  accessCerts: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  anthropic: "https://api.anthropic.com",
  github: "https://api.github.com",
};
const FAKES = {
  accessCerts: "http://localhost:5199/access/cdn-cgi/access/certs",
  anthropic: "http://localhost:5199/anthropic",
  github: "http://localhost:5199/github",
};

describe("開発環境の代わりの物", () => {
  it("本番の値では本物の宛先を返す", () => {
    expect(endpoints({ ENVIRONMENT: "production", ACCESS_TEAM: "team", DEV_FAKES_URL: "http://localhost:5199" })).toEqual(REAL);
  });

  it("ENVIRONMENT が無ければ本物の宛先を返す", () => {
    expect(endpoints({ ACCESS_TEAM: "team", DEV_FAKES_URL: "http://localhost:5199" })).toEqual(REAL);
  });

  it("development の時だけ代わりの物の宛先を返す", () => {
    expect(endpoints({ ENVIRONMENT: "development", ACCESS_TEAM: "team", DEV_FAKES_URL: "http://localhost:5199" })).toEqual(FAKES);
  });

  it.each(["Development", "dev", "", "preview", " development"])("ENVIRONMENT が %j の時は本物の宛先を返す", (value) => {
    expect(endpoints({ ENVIRONMENT: value, ACCESS_TEAM: "team", DEV_FAKES_URL: "http://localhost:5199" })).toEqual(REAL);
  });

  it.each(["http://localhost:5199@evil.example", "http://localhost:5199/", "http://localhost.evil.example:5199", "https://localhost:5199"])(
    "development でも DEV_FAKES_URL が %j なら使わない",
    (url) => {
      expect(() => endpoints({ ENVIRONMENT: "development", ACCESS_TEAM: "team", DEV_FAKES_URL: url })).toThrow(expect.objectContaining({ code: "internal" }));
    },
  );

  it("development でも代わりの物が手元に無ければ使わない", () => {
    expect(() => endpoints({ ENVIRONMENT: "development", ACCESS_TEAM: "team", DEV_FAKES_URL: "https://evil.example.com" })).toThrow(
      expect.objectContaining({ code: "internal" }),
    );
    expect(() => endpoints({ ENVIRONMENT: "development", ACCESS_TEAM: "team" })).toThrow(expect.objectContaining({ code: "internal" }));
  });

  it("ACCESS_TEAM は名前だけを受ける", () => {
    expect(() => endpoints({ ENVIRONMENT: "production", ACCESS_TEAM: "evil.example.com/x?" })).toThrow(expect.objectContaining({ code: "internal" }));
  });
});
