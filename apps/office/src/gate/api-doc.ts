// API の文書 (OpenAPI 3.1) をコードのルートとスキーマから作る。apps/office/openapi/v1.yaml はこれを書き出した物で、手で直さない
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { stringify } from "yaml";
import { workspaceGateRoutes } from "./egress.ts";
import gate from "./index.ts";
import { PLANNED_ROUTES } from "./routes/planned.ts";
import { WORKSPACE_ROUTES } from "./work/workspace-api.ts";

/** 文書の版。本番に出す前は上げない (API の決まりの 4.4) */
const VERSION = "1.18.0";

/** 何も書かないルートの認証。Access の証明とログインセッションの両方を求める */
const DEFAULT_SECURITY = [{ accessJwt: [], session: [] }];

/** パスの頭ごとの宛先。ゲートウェイの外から呼ぶルートだけを書く */
const PATH_SERVERS: [string, { url: string; description: string }][] = [
  ["/ws/v1/", { url: "http://gate.internal", description: "ワークスペースからの通信を中継するプロキシ" }],
  ["/v1/", { url: "http://workspace:8080", description: "ワークスペースの Node サーバー。社員 DO だけが呼ぶ" }],
];

const TAGS = [
  ["system", "システム: ヘルスチェック、エラーログ、監査ログ、ストレージ使用量、API ドキュメント"],
  ["auth", "認証: ログインセッション、パスキー"],
  ["staff", "社員: 状態、勤怠、当日の指示"],
  ["records", "レポート: ダッシュボード、勤怠と稼働の集計、改善の Issue"],
  ["guard", "自動停止: 停止、解除、しきい値、改善案"],
  ["conversation", "会話: メッセージ、リアルタイム配信"],
  ["nodes", "タスク: 目的、目標、プロジェクト、タスクの木"],
  ["org", "組織: 組織図、役割の指示文、オーナーの承認"],
  ["reviews", "レビュー: 差分、コメント、承認"],
  ["github", "GitHub 連携: App、Webhook、ルール"],
  ["services", "サービス: アイデアから運用まで"],
  ["devloop", "開発の回し方: 設計書のリポジトリ"],
  ["settings", "設定: office とサービス"],
  ["notices", "通知"],
  ["extensions", "拡張機能"],
  ["workspace-gate", "内部 API: ワークスペースからゲートウェイへ"],
  ["workspace", "内部 API: 社員 DO からワークスペースへ"],
] as const;

const SECURITY_SCHEMES = {
  accessJwt: { type: "apiKey", in: "header", name: "Cf-Access-Jwt-Assertion", description: "Cloudflare Access (Google) のログインの証明" },
  session: {
    type: "apiKey",
    in: "cookie",
    name: "__Host-ko_session",
    description: "HMAC で署名したログインセッション。__Host- 付きのため、別のサブドメインから上書きできない",
  },
  workToken: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "タスクごとに発行する 1 時間有効の作業トークン (HS256)" },
  workspaceKey: {
    type: "http",
    scheme: "bearer",
    description: "ワークスペースの DO がコンテナを起こすたびに作り、環境変数で渡す鍵。社員 DO の呼び出しだけが持つ",
  },
} as const;

const METHODS = ["get", "put", "post", "delete", "patch"] as const;

type Document = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;
type PathItem = NonNullable<Document["paths"]>[string];
type Operation = NonNullable<PathItem["get"]>;

/** createRoute に分けて書いた、処理の順とこのルートだけの失敗 */
const RouteNotes = z.object({ "x-steps": z.array(z.string()).min(1), "x-errors": z.array(z.string()).min(1).optional() });

/**
 * 操作の説明に、処理の順とこのルートだけの失敗を足す。createRoute には説明の頭、x-steps、x-errors を分けて書く
 * @param op createRoute から作った操作
 * @returns 説明を書き足し、認証を書いていない操作に既定の認証を入れた操作
 */
function complete(op: Operation): Operation {
  const notes = RouteNotes.parse(op);
  const parts = [op.description, ["処理の流れ:", notes["x-steps"].map((step, i) => `${i + 1}. ${step}`).join("\n")].join("\n\n")];
  if (notes["x-errors"]) parts.push(["このルート固有のエラー:", notes["x-errors"].map((error) => `- ${error}`).join("\n")].join("\n\n"));
  return { ...op, description: parts.filter((part) => part !== undefined).join("\n\n"), security: op.security ?? DEFAULT_SECURITY };
}

/**
 * パスの 1 項目に、宛先と書き足した操作を入れる
 * @param path パス
 * @param item createRoute から作ったパスの 1 項目
 * @returns 宛先と操作。宛先はゲートウェイの外から呼ぶルートだけに付ける
 */
function completePath(path: string, item: PathItem): PathItem {
  const server = PATH_SERVERS.find(([head]) => path.startsWith(head));
  const out: PathItem = server ? { servers: [server[1]] } : {};
  for (const method of METHODS) {
    const op = item[method];
    if (op) out[method] = complete(op);
  }
  return out;
}

/**
 * コードのルートとスキーマから OpenAPI の文書を作る。ゲートウェイ、ワークスペースの受け手、ワークスペースのサーバー、まだ作っていないルートを 1 つにまとめる
 * @returns OpenAPI 3.1 の文書
 */
export function openApiDocument() {
  const docs = new OpenAPIHono().route("/", gate).route("/", workspaceGateRoutes());
  for (const route of WORKSPACE_ROUTES) docs.openAPIRegistry.registerPath(route);
  for (const { route } of PLANNED_ROUTES) docs.openAPIRegistry.registerPath(route);
  const generated = docs.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "know-office API",
      version: VERSION,
      description:
        "know-office のゲートウェイと、ワークスペースとの間の API。規約は knowidea の services/know-office/docs/04-detail/index.md の 4 章。成功時は {data, meta}、失敗時は RFC 9457 の application/problem+json を返す。",
    },
    servers: [{ url: "/", description: "know-office の Worker。画面と同じオリジン" }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    security: DEFAULT_SECURITY,
  });
  const paths = Object.fromEntries(Object.entries(generated.paths ?? {}).map(([path, item]) => [path, completePath(path, item)]));
  const { webhooks: _webhooks, ...rest } = generated;
  return { ...rest, paths, components: { securitySchemes: SECURITY_SCHEMES, ...generated.components } };
}

/**
 * 文書を v1.yaml の中身にする。YAML 1.1 で読む道具 (PyYAML) が off や yes を真偽にしないよう、1.1 の決まりで引用符を付ける
 * @returns YAML の文
 */
export function openApiYaml(): string {
  return `# know-office の API の文書。apps/office/src/gate/ の createRoute と core の Zod スキーマから作る。手で直さず、pnpm --filter @know-office/office openapi で作り直す\n${stringify(openApiDocument(), { lineWidth: 0, version: "1.1" })}`;
}
