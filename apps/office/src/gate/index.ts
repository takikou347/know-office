// ゲートウェイ。API はすべて /api/v1 の下に置き、ほかのパスは画面のファイルを返す
import { createApp } from "./app.ts";
import { registerComponents } from "./openapi.ts";
import { system } from "./routes/system.ts";

const gate = createApp().route("/", system);

registerComponents(gate);

export type Gate = typeof gate;

export default gate;
