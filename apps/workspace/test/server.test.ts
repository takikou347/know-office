import type { AddressInfo } from "node:net";
import type { Health } from "@know-office/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspaceServer } from "../src/server.ts";

describe("作業場", () => {
  const server = createWorkspaceServer();
  let base = "";

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("/health が作業場の様子を返す", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body).toEqual({ ok: true, part: "workspace" });
  });

  it("無い道は 404 を返す", async () => {
    const res = await fetch(`${base}/nothing`);
    expect(res.status).toBe(404);
  });
});
