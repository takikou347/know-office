// 利用場面の通しの後始末。後始末が落ちても本体の最初のエラーを隠さず、後始末はすべて走らせる

/**
 * 本体を走らせ、通っても落ちても後始末を順にすべて走らせる
 * 本体が落ちた時は本体のエラーを投げ、後始末のエラーはその cause に残す。本体が通った時は後始末のエラーを投げる
 * @param body 通しの本体
 * @param undo 後始末。前の物が落ちても次を走らせる
 * @throws 本体のエラー、本体が通った時は後始末のエラー (2 つ以上なら AggregateError)
 */
export async function settle(body: () => Promise<void>, undo: readonly (() => unknown)[]): Promise<void> {
  let failure: { error: unknown } | null = null;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  const undone: unknown[] = [];
  for (const step of undo) {
    try {
      await step();
    } catch (error) {
      undone.push(error);
    }
  }
  if (failure !== null) {
    if (undone.length > 0 && failure.error instanceof Error && failure.error.cause === undefined) failure.error.cause = new AggregateError(undone, "後始末でも落ちた");
    throw failure.error;
  }
  if (undone.length === 1) throw undone[0];
  if (undone.length > 1) throw new AggregateError(undone, "後始末が落ちた");
}
