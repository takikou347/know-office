// レビューの画面が入口から読む物。概要、1 ファイルの差分、ファイルの中身を読み、knowidea-ui の DiffView の形に直す (タスクとレビューの 3.6)
import type { FileDiff, ReviewHead } from "@know-office/core";
import type { DiffFile, DiffLine } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../../api.ts";

const Failure = z.object({ code: z.string(), traceId: z.string() }).loose();

/** 読んでいる、読めた、読めなかった。読めなかった時は code で分け、不具合を伝えられるよう traceId を持つ */
export type Loaded<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "failed"; code: string; traceId: string | null };

/** 読めなかった事 */
export type Failed = Extract<Loaded<unknown>, { state: "failed" }>;

/**
 * 失敗の返事から code と traceId を読む
 * @param res 入口の返事
 * @returns 読めなかった事
 */
export async function failureOf(res: Response): Promise<Failed> {
  const body = Failure.safeParse(await res.json().catch(() => null));
  return body.success ? { state: "failed", code: body.data.code, traceId: body.data.traceId } : { state: "failed", code: String(res.status), traceId: null };
}

/** 入口につながらなかった事 */
export const NETWORK: Failed = { state: "failed", code: "network", traceId: null };

/**
 * 入口を 1 度呼んで読み、鍵が変わったら読み直す。入口を呼ぶ口が無い時 (サーバーで描く時とテスト) は読めなかった事にする
 * @param key 何を読むかの鍵。変われば読み終えるまで読んでいる事にする
 * @param load 入口を呼んで data を返す。失敗の返事は Failed を返す
 * @returns 読んでいる、読めた、読めなかった
 */
export function useLoad<T>(key: string, load: (api: Api) => Promise<T | Failed>): Loaded<T> {
  const api = useContext(ApiContext);
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded<T> }>({ key: "", value: { state: "loading" } });
  useEffect(() => {
    let live = true;
    if (api) {
      void load(api)
        .then((v): Loaded<T> => (isFailed(v) ? v : { state: "ok", data: v }))
        .catch((): Loaded<T> => NETWORK)
        .then((value) => {
          if (live) setLoaded({ key, value });
        });
    }
    return () => {
      live = false;
    };
    // load は呼ぶたびに作られるので、鍵だけで読み直す
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  if (!api) return NETWORK;
  return loaded.key === key ? loaded.value : { state: "loading" };
}

/**
 * 読めなかった事か
 * @param v 読んだ物か読めなかった事
 * @returns 読めなかった事なら true
 */
function isFailed(v: unknown): v is Failed {
  return typeof v === "object" && v !== null && "state" in v && v.state === "failed";
}

/**
 * レビューの概要を読む
 * @param nodeId 作った社員のタスク ID
 * @param version 読み直す時に変える数
 * @returns 概要
 */
export function useReviewHead(nodeId: string, version: number): Loaded<ReviewHead> {
  return useLoad(`${nodeId}/${String(version)}`, async (api) => {
    const res = await api.api.v1.reviews[":nodeId"].$get({ param: { nodeId } });
    return res.ok ? (await res.json()).data : failureOf(res);
  });
}

/** 作業中の変更の元と先。概要が返した物で、差分もこの 2 つの間を読む */
export type WorkingRange = { baseSha: string; headSha: string };

/**
 * 1 ファイルの差分を読む。開いた時だけ呼ぶ
 * @param nodeId 作った社員のタスク ID
 * @param path ファイルの道
 * @param since 前に見た先。あればそこからの差だけを読む
 * @param head 今の先。変われば読み直す
 * @param range 作業中の変更の元と先。あれば since を使わずこの間を読む
 * @returns 差分
 */
export function useFileDiff(nodeId: string, path: string, since: string | null, head: string, range: WorkingRange | null = null): Loaded<FileDiff> {
  return useLoad(`${nodeId}/${path}/${since ?? ""}/${head}`, async (api) => {
    const query = range === null ? (since === null ? { path } : { path, since }) : { path, ...range };
    const res = await api.api.v1.reviews[":nodeId"].diff.$get({ param: { nodeId }, query });
    return res.ok ? (await res.json()).data : failureOf(res);
  });
}

/** 画面のファイルの種類から DiffView の種類へ */
const STATUS: Record<ReviewHead["files"][number]["status"], DiffFile["status"]> = { added: "added", modified: "modified", removed: "deleted", renamed: "renamed" };

/**
 * 入口の差分を DiffView の形に直す。行の頭の印から種類を決め、前と後の行の番号を数える
 * @param diff 入口の差分
 * @param status ファイルの種類
 * @returns DiffView のファイル
 */
export function toDiffFile(diff: FileDiff, status: ReviewHead["files"][number]["status"]): DiffFile {
  return {
    path: diff.path,
    status: STATUS[status],
    hunks: diff.hunks.map((h) => {
      let oldNumber = h.oldStart;
      let newNumber = h.newStart;
      const lines = h.lines.map((raw): DiffLine => {
        const text = raw.slice(1);
        if (raw.startsWith("+")) return { type: "add", newNumber: newNumber++, text };
        if (raw.startsWith("-")) return { type: "del", oldNumber: oldNumber++, text };
        return { type: "context", oldNumber: oldNumber++, newNumber: newNumber++, text };
      });
      return { header: `@@ -${String(h.oldStart)} +${String(h.newStart)} @@`, lines };
    }),
  };
}
