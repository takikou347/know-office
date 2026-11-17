// 開発の代わりの物の置き場が受けた補完の切り替え (/workspace/<社員 ID>/v1/lsp) を、起こした Node のワークスペースへ TCP でそのまま渡す (ログインと記録の 3.9、仕事とレビューの 3.6)
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { DevWorkspaces } from "./workspace.ts";

/** 渡す道。社員 ID と /v1/lsp の後のクエリ */
const LSP_PATH = /^\/workspace\/([a-z]+)(\/v1\/lsp)(\?.*)?$/;

/**
 * 断る返事を書いて閉じる
 * @param socket 接続
 * @param status ステータスの行
 */
function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * 切り替えを受ける関数を作る。node:http の upgrade に付ける
 * @param workspaces 代わりのワークスペースの置き場
 * @returns upgrade を受ける関数
 */
export function devUpgrade(workspaces: DevWorkspaces): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    const match = LSP_PATH.exec(req.url ?? "");
    if (!match) {
      refuse(socket, "404 Not Found");
      return;
    }
    const [, staffId = "", path = "", search = ""] = match;
    workspaces
      .serverPort(staffId)
      .then((port) => {
        if (port === null) {
          refuse(socket, "502 Bad Gateway");
          return;
        }
        const upstream = connect(port, "127.0.0.1");
        // 鍵を含む要求の頭をそのまま渡す。確かめは Node のワークスペースがする
        const lines = [`${req.method ?? "GET"} ${path}${search} HTTP/1.1`];
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i] ?? ""}: ${req.rawHeaders[i + 1] ?? ""}`);
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.byteLength > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
      })
      .catch(() => refuse(socket, "502 Bad Gateway"));
  };
}
