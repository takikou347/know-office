// 社員の名札が重ならないように、奥 (画面の上) の名札から上へずらす量を決める

/** 名札の箱 (CSS のピクセル)。x は真ん中、bottom は下の端 */
export interface TagBox {
  id: string;
  x: number;
  bottom: number;
  width: number;
  height: number;
}

/** 名札どうしの間 */
const GAP = 2;

/**
 * 名札が重ならないように、上へずらす量を決める。手前 (下の端が下) の名札から順に置き、重なる奥の名札をその上へ動かす
 * @param tags 名札の箱
 * @returns 社員の id ごとの、上へずらす量
 */
export function spreadTags(tags: readonly TagBox[]): Record<string, number> {
  const shift: Record<string, number> = {};
  const placed: { box: TagBox; top: number }[] = [];
  for (const box of tags.toSorted((a, b) => b.bottom - a.bottom)) {
    let top = box.bottom - box.height;
    // 置いた名札と重なる間は、その上へ動かす。動かした先で別の名札と重なる事もあるので、重ならなくなるまで繰り返す
    for (let moved = true; moved; ) {
      moved = false;
      for (const p of placed) {
        const sideBySide = Math.abs(box.x - p.box.x) < (box.width + p.box.width) / 2;
        const stacked = top < p.top + p.box.height && p.top < top + box.height;
        if (sideBySide && stacked) {
          top = p.top - box.height - GAP;
          moved = true;
        }
      }
    }
    shift[box.id] = box.bottom - box.height - top;
    placed.push({ box, top });
  }
  return shift;
}
