// テストのファイルの終わりに止める物を並べる。D1 と DO の workerd はファイルで 1 つ起こし、test/setup.ts の afterAll でここから止める
/** 止める物 */
const stops = new Set<() => Promise<void>>();

/**
 * ファイルの終わりに止める物を足す
 * @param stop 止める関数
 */
export function atFileEnd(stop: () => Promise<void>): void {
  stops.add(stop);
}

/**
 * 足した物を全部止める。test/setup.ts がファイルの終わりに呼ぶ
 */
export async function endFile(): Promise<void> {
  const list = [...stops];
  stops.clear();
  await Promise.all(list.map((stop) => stop()));
}
