import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { assertPortFree } from "../../dev/server.ts";

describe("手元で動かす", () => {
  it("代わりの物の番号を前のサーバーが使っていれば、止め方の分かる誤りで止める", async () => {
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
    const address = held.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(assertPortFree(port)).rejects.toThrow(`lsof -ti tcp:${String(port)} | xargs kill`);
    } finally {
      held.close();
    }
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });
});
