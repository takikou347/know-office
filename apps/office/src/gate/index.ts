// 入口。API はすべて /api の下に置き、ほかの道は画面のファイルを返す
import { type Health, health } from "@know-office/core";
import { Hono } from "hono";

// 道はつなげて書く。画面が Gate の型から、道と返す形を受け取る
const gate = new Hono().get("/api/health", (c) => c.json<Health>(health("gate")));

export type Gate = typeof gate;

export default gate;
