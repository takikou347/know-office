// 作業場。社員の状態からの命令を受ける。今は様子を返すだけ
import { createServer, type Server } from "node:http";
import { health } from "@know-office/core";

export function createWorkspaceServer(): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(health("workspace")));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
}
