// ルールの判断が道を見る所。置き場の外、書けない所、鍵の置き場を見分ける (社員が考えるの 3.4)

// /work の外でも触ってよい物。出力を捨てる先だけ
const OUTSIDE_OK = ["/dev/null"];

// 鍵の置き場。SSH の鍵、.env (見本を除く)、.pem、wrangler の .dev.vars
const SECRET_PATH = [
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,
  /(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[\w.-]+)?$/,
  /\.pem$/,
  /(?:^|\/)\.dev\.vars(?:\.[\w.-]+)?$/,
];

/**
 * 道を / から始まる形に直す。相対の道は root から読み、. と .. を畳む
 * @param path 道
 * @param root 相対の道の頭
 * @returns 畳んだ絶対の道
 */
export function normalize(path: string, root: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${root}/${path}`).split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * 道が置き場の下にあるかを確かめる。相対の道は置き場の頭から読む
 * @param path 道
 * @param workRoot 社員が触れてよい置き場
 * @returns 下にあれば true
 */
export function inside(path: string, workRoot: string): boolean {
  // ~ は社員の家の置き場、$ で始まる道は中身が分からないので、どちらも外とみる
  if (path.startsWith("~") || path.startsWith("$")) return false;
  const root = normalize(workRoot, "/");
  const full = normalize(path, root);
  return full === root || full.startsWith(`${root}/`) || OUTSIDE_OK.includes(full);
}

/**
 * 道が書けない所に当たるかを確かめる。置き場の下のどの深さのリポジトリでも当てる
 * @param path 道
 * @param workRoot 社員が触れてよい置き場
 * @param protectedPaths 書けない所
 * @returns 当たれば true
 */
export function protectedPath(path: string, workRoot: string, protectedPaths: readonly string[]): boolean {
  const full = `${normalize(path, normalize(workRoot, "/"))}/`;
  return protectedPaths.some((p) => full.includes(`/${trimSlashes(p)}/`));
}

/**
 * 道が書けない所の親のどれかかを確かめる。cd で入った後の相対の道で書けない所に届くのを防ぐ
 * @param path 道
 * @param workRoot 社員が触れてよい置き場
 * @param protectedPaths 書けない所
 * @returns 親に当たれば true
 */
export function protectedParent(path: string, workRoot: string, protectedPaths: readonly string[]): boolean {
  const full = normalize(path, normalize(workRoot, "/"));
  return protectedPaths.some((p) => {
    const parts = trimSlashes(p).split("/");
    return parts.some((_part, i) => i > 0 && full.endsWith(`/${parts.slice(0, i).join("/")}`));
  });
}

/**
 * 道が鍵の置き場を指すかを確かめる
 * @param path 道か Glob の型
 * @returns 指せば true
 */
export function secretPath(path: string): boolean {
  return SECRET_PATH.some((p) => p.test(path));
}

/**
 * 道の頭と終わりの / を外す
 * @param path 道
 * @returns / を外した道
 */
function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
