// 触るファイルの glob の固定の頭と重なり、テストのファイルの判定 (開発の回し方の 3.5)

/** glob の記号。ここから先は固定の頭に入れない */
const GLOB_MARKS = /[*?[{]/;

/** テストのファイルの名前。`*.test.*` と `*.spec.*` */
const TEST_FILE = /\.(?:test|spec)\.[^/]+$/;

/**
 * glob の固定の頭を返す。最初の `*`、`?`、`[`、`{` より前で、頭の `./` は取り除く。頭が `!` (否定) か `\` (エスケープ) の glob は、何と重なるか言えないので空にする
 * @param glob 触るファイルの glob
 * @returns 固定の頭。空ならすべてと重なる
 */
export function globHead(glob: string): string {
  let rest = glob;
  while (rest.startsWith("./")) rest = rest.slice(2);
  if (rest.startsWith("!") || rest.startsWith("\\")) return "";
  const mark = GLOB_MARKS.exec(rest);
  return mark === null ? rest : rest.slice(0, mark.index);
}

/**
 * 2 つの glob の組が重なるかを、固定の頭で比べる。どちらかの頭が他方の頭で始まれば重なり、頭が空ならすべてと重なる
 * @param a 1 つ目の組の glob
 * @param b 2 つ目の組の glob
 * @returns 重なるなら true
 */
export function globsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const heads = b.map(globHead);
  return a.map(globHead).some((x) => heads.some((y) => x.startsWith(y) || y.startsWith(x)));
}

/**
 * 変えたファイルにテストのファイル (`*.test.*`、`*.spec.*`) があるか
 * @param paths 変えたファイルの道
 * @returns あれば true
 */
export function hasTestFile(paths: readonly string[]): boolean {
  return paths.some((p) => TEST_FILE.test(p));
}
