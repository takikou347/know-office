// テストの配信 DO の代わり。LiveDO と同じ作業トークンの本を持ち、配った出来事と閉じさせた接続を並べる
import { LiveTickets } from "../../src/gate/live/tickets.ts";
import { overRpc } from "./rpc.ts";

/** 配信 DO の代わりが覚えた事 */
export type TestLive = {
  /** 配った出来事 */
  published: unknown[];
  /** WebSocket に切り替えに来た要求 */
  opened: Request[];
  /** 閉じさせたログインセッション。全部を閉じさせた時は * */
  closed: string[];
  /** 同時の数に入れている補完の接続 */
  lsp: { staffId: string; openedAt: number }[];
};

/**
 * 配信 DO の代わりを作る
 * @returns 覚えた事と、DO の RPC の代わり
 */
export function fakeLive() {
  const live: TestLive = { published: [], opened: [], closed: [], lsp: [] };
  const ticketMap = new Map<string, unknown>();
  const tickets = new LiveTickets({
    get: (key) => ticketMap.get(key),
    put: (key, value) => void ticketMap.set(key, value),
    delete: (key) => ticketMap.delete(key),
    list: ({ prefix }) => [...ticketMap.entries()].filter(([key]) => key.startsWith(prefix)),
  });
  const liveDo = {
    issue: overRpc(tickets.issue.bind(tickets)),
    redeem: tickets.redeem.bind(tickets),
    closeSession: (sessionId: string) => {
      live.closed.push(sessionId);
      return Promise.resolve(null);
    },
    closeIp: (ip: string) => {
      live.closed.push(`ip:${ip}`);
      return Promise.resolve(null);
    },
    closeAll: () => {
      live.closed.push("*");
      return Promise.resolve(null);
    },
    holdLsp: (staffId: string, openedAt: number) => {
      live.lsp = [...live.lsp.filter((l) => l.staffId !== staffId), { staffId, openedAt }];
      return Promise.resolve(null);
    },
    releaseLsp: (staffId: string, openedAt: number) => {
      live.lsp = live.lsp.filter((l) => l.staffId !== staffId || l.openedAt !== openedAt);
      return Promise.resolve(null);
    },
    publish: (event: unknown) => {
      live.published.push(event);
      return Promise.resolve(null);
    },
    fetch: (url: string, init?: { headers?: Record<string, string> }) => {
      live.opened.push(new Request(url, { headers: init?.headers ?? {} }));
      // workerd でないので 101 は作れない。切り替えまで届いた事だけを 200 で返す
      return Promise.resolve(new Response("opened", { status: 200 }));
    },
  };
  return { live, liveDo };
}
