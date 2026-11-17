// 開発環境の代わりの GitHub の形。届いた要求、作った App、出した鍵、テストが触る口と、App を作る時に受ける manifest
import type { KeyObject } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { FakePosted, FakeTreeEntry } from "./github-pulls.ts";

/** 代わりの GitHub の App が持てる権限。know-office の manifest と同じ */
export const Permission = z.enum(["read", "write"]);
/** 受ける manifest。know-office の manifest と同じ形 */
export const Manifest = z
  .object({
    name: z.string().min(1),
    url: z.string(),
    redirect_url: z.string(),
    setup_url: z.string(),
    hook_attributes: z.object({ url: z.string() }).loose(),
    public: z.boolean(),
    default_permissions: z.record(z.string(), Permission),
    default_events: z.array(z.string()),
  })
  .loose();

/** 届いた要求 */
export type GitHubRequest = {
  /** 「メソッド パス」 */
  route: string;
  /** 本文。JSON でなければ null */
  body: unknown;
  /** 付いていた鍵。Bearer か、git の Basic の合言葉 */
  token: string | null;
};

/** 代わりの GitHub が作った App */
export type FakeApp = {
  /** App ID */
  id: number;
  /** URL に入る名前 */
  slug: string;
  /** 受けた manifest */
  manifest: z.infer<typeof Manifest>;
  /** 通知の秘密 */
  webhookSecret: string;
  /** 秘密鍵に対の公開鍵。App の JWT を確かめる */
  publicKey: KeyObject;
};

/** 代わりの GitHub が出した、インストールの 1 時間の鍵 */
export type FakeToken = {
  /** インストール ID */
  installationId: number;
  /** 届くリポジトリ (owner/name)。null はインストールで選んだすべて */
  repos: string[] | null;
  /** 権限 */
  permissions: Record<string, "read" | "write">;
  /** 期限 (協定世界時のミリ秒) */
  expiresAt: number;
};

/** 代わりの GitHub */
export type FakeGitHub = {
  /** GitHub の REST API、画面、git の形の Hono。画面は /web、git は /git の下 */
  app: Hono;
  /** 届いた要求 */
  requests: GitHubRequest[];
  /** git の受け口に届いた本文のバイト数と Content-Encoding */
  gitBodies: { route: string; bytes: number; encoding: string | null }[];
  /** 次に git の受け口が返すステータス。null なら確かめた上で 200 */
  gitStatus: number | null;
  /** 次に出す 1 時間の鍵の返事に被せる中身。広い鍵を返す GitHub の代わり */
  nextMint: { repositories?: { full_name: string }[]; permissions?: Record<string, "read" | "write"> } | null;
  /** 取り消された 1 時間の鍵 */
  revoked: string[];
  /** リポジトリの既定のブランチ。無ければ main */
  defaultBranches: Map<string, string>;
  /** 「メソッド パス」に返す本文を置く。undefined は置いた本文を消し、404 に戻す */
  set(route: string, body: unknown): void;
  /** 作った App。ID から */
  apps: Map<number, FakeApp>;
  /** インストール。ID から、App ID と選んだリポジトリ */
  installations: Map<number, { appId: number; repos: string[] }>;
  /** 出した 1 時間の鍵。鍵から */
  tokens: Map<string, FakeToken>;
  /** 次のインストールでオーナーが選ぶリポジトリと、公開か */
  pick: { fullName: string; private: boolean }[];
  /** オーナーが GitHub の画面で App を外す */
  uninstall(installationId: number): void;
  /** オーナーが GitHub App の画面で秘密鍵を作り直し、前の秘密鍵を消す。新しい秘密鍵 (PKCS#1 の PEM) を返す */
  newPrivateKey(appId: number): string;
  /** 受けたレビューと行のコメントの後に GitHub が送る通知。テストがゲートウェイへ送る */
  sent: { event: string; payload: unknown }[];
  /** 次にこの「メソッド パス」に返すステータス。1 度だけ効く */
  failNext(route: string, status: number, headers?: Record<string, string>): void;
  /** ブランチの先のコミット。「owner/name:ブランチ」から */
  heads: Map<string, string>;
  /** Git の木の中身。木の sha から。無い木は空の木として返す */
  trees: Map<string, FakeTreeEntry[]>;
  /** 受けたレビューと行のコメント。一覧の API が返す */
  posted: FakePosted;
  /** tarball の中身 (tar.gz)。「owner/name:sha」から。API は 302 で codeload の形の道を返す */
  archives: Map<string, Uint8Array>;
  /** codeload の形の道 (/{o}/{r}/legacy.tar.gz/{sha}?token=)。代わりの物の置き場の /codeload に付ける */
  codeload: Hono;
};

/** 代わりの GitHub の設定 */
export type FakeGitHubOptions = {
  /** 今の時刻。1 時間の鍵の期限と、App の JWT の期限に使う */
  now?: () => number;
  /** App を作る時の RSA の鍵の組を作る。無ければその場で作る。テストは作った鍵を使い回して速くする */
  appKey?: () => { privateKey: KeyObject; publicKey: KeyObject };
  /** tarball の 302 の先。無ければ https://codeload.github.com */
  codeloadBase?: string;
};
