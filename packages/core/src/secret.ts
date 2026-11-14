// 鍵の入れ物。文字や JSON にすると伏せ、記録と返事とログに中身を出さない (コード規約の 2 章)

/** 鍵を持つ入れ物。中身は reveal() でだけ読む */
export class Secret {
  readonly #value: string;

  /**
   * 鍵を入れる
   * @param value 鍵
   */
  constructor(value: string) {
    this.#value = value;
  }

  /**
   * 中身を返す。外へ送る直前にだけ呼ぶ
   * @returns 鍵
   */
  reveal(): string {
    return this.#value;
  }

  /**
   * 文字にした時の形
   * @returns 伏せた印
   */
  toString(): string {
    return "***";
  }

  /**
   * JSON にした時の形
   * @returns 伏せた印
   */
  toJSON(): string {
    return "***";
  }
}
