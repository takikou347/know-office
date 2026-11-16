// 入口から読む、入口へ送る時の共通の形。読んでいる、読めた、読めなかったと、失敗の code と traceId
import { Alert } from "knowidea-ui";
import { useContext, useEffect, useState } from "react";
import { z } from "zod";
import { type Api, ApiContext } from "../api.ts";
import { type StepUpOptions, withStepUp } from "./step-up.ts";

const Failure = z.object({ code: z.string(), traceId: z.string(), detail: z.string().optional() }).loose();

/** 読めなかった時と送れなかった時の理由。不具合を伝えられるよう traceId を添える。detail は入口が返した説明で、出す所だけが使う */
export type Failed = { code: string; traceId: string | null; detail?: string };

/** 入口から読む物の今。読んでいる、読めた、読めなかった */
export type Loaded<T> = { state: "loading" } | { state: "ok"; data: T } | ({ state: "failed" } & Failed);

/** 入口の返事のうち、読むのに使う所 */
export type Reply = { ok: boolean; status: number; json(): Promise<unknown> };

/**
 * 失敗の返事から code と traceId を読む
 * @param res 返事
 * @returns code と traceId
 */
export async function failureOf(res: Reply): Promise<Failed> {
  const body = Failure.safeParse(await res.json().catch(() => null));
  if (!body.success) return { code: String(res.status), traceId: null };
  return { code: body.data.code, traceId: body.data.traceId, ...(body.data.detail === undefined ? {} : { detail: body.data.detail }) };
}

/**
 * 入口から読み、返った data を形で確かめる。入口を呼ぶ口が無ければ読めなかった事にする
 * @param schema data の形
 * @param read 入口を呼んで返事を返す
 * @param tick 読み直す時に変える数。同じ数の間は 1 度だけ読む
 * @returns 読んでいる、読めた、読めなかった
 */
export function useLoad<T>(schema: z.ZodType<T>, read: (api: Api) => Promise<Reply>, tick = 0): Loaded<T> {
  const api = useContext(ApiContext);
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    // 入口を呼ぶ口が無い時は読みに行かない。返す形は下で読めなかった事にする
    void (api ? read(api) : Promise.reject(new Error("入口を呼ぶ口が無い")))
      .then(async (res): Promise<Loaded<T>> => {
        if (res.ok) return { state: "ok", data: z.object({ data: schema }).loose().parse(await res.json()).data };
        return { state: "failed", ...(await failureOf(res)) };
      })
      .catch((): Loaded<T> => ({ state: "failed", code: "network", traceId: null }))
      .then((value) => {
        if (live) setLoaded(value);
      });
    return () => {
      live = false;
    };
    // 読み方は描くたびに作り直すが、同じ入口と同じ数からは 1 度だけ読む
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tick]);
  if (!api) return { state: "failed", code: "network", traceId: null };
  return loaded;
}

/**
 * 入口へ送り、パスキーの確認を求められたら確かめてから 1 度だけ送り直す。つながらない時とパスキーを確かめられなかった時も失敗にして返す
 * @param api 入口を呼ぶ口
 * @param call 送る操作
 * @param options 必ずパスキーの確認を求める操作なら required
 * @returns 成功の返事か、失敗の理由
 */
export async function send<R extends Reply>(api: Api, call: () => Promise<R & Response>, options: StepUpOptions = {}): Promise<{ ok: true; res: R } | { ok: false; failure: Failed }> {
  let started = 0;
  let finished = 0;
  let checking = options.required === true;
  const res = await withStepUp(
    api,
    async () => {
      checking = false;
      started += 1;
      const reply = await call();
      finished += 1;
      return reply;
    },
    options,
  ).catch(() => null);
  // 送る前の確認の途中か、1 度目の返事を受けた後で送り直す前に投げられたのは、パスキーの確認の途中だけ。ほかは入口につながらなかった
  if (!res) return { ok: false, failure: { code: checking || (started === 1 && finished === 1) ? "step_up_failed" : "network", traceId: null } };
  if (!res.ok) return { ok: false, failure: await failureOf(res) };
  // withStepUp は呼んだ操作の返事をそのまま返す
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ok: true, res: res as R & Response };
}

/** 失敗の code ごとの、オーナーに出す文。無い code は code をそのまま出す */
const REASON: Record<string, string> = {
  network: "入口につながりません。",
  step_up_failed: "パスキーで確かめられませんでした。",
  conflict: "ほかの所で先に変わりました。",
  stopped: "社員が止まっています。",
  step_up_required: "パスキーで確かめてから出してください。",
  validation_failed: "入れた値の形が違います。",
};

export interface FailedAlertProps {
  /** 題 */
  title: string;
  /** 理由 */
  failure: Failed;
}

/** 読めなかった事、送れなかった事を出す */
export function FailedAlert({ title, failure }: FailedAlertProps) {
  return (
    <Alert tone="error" title={title} live>
      {REASON[failure.code] ?? `理由: ${failure.code}。`}
      {failure.traceId ? ` 問い合わせの番号: ${failure.traceId}` : null}
    </Alert>
  );
}
