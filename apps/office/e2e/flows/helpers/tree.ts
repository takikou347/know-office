// 利用場面の通しで、代わりの GitHub に置くリポジトリの木 (tarball) を組む。GitHub の tarball と同じく頭に 1 段のフォルダを付けた ustar を gzip にする
import { gzipSync } from "node:zlib";

/**
 * 数を 8 進の欄に書く
 * @param header 枠
 * @param offset 欄の頭
 * @param length 欄の長さ
 * @param value 数
 */
function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

/**
 * tar の 1 件の枠を作る
 * @param name 道
 * @param size 中身の長さ。フォルダは 0
 * @param dir フォルダか
 * @returns 512 バイトの枠
 */
function entryHeader(name: string, size: number, dir: boolean): Buffer {
  const out = Buffer.alloc(512);
  out.write(name, 0, 100, "utf8");
  octal(out, 100, 8, dir ? 0o755 : 0o644);
  octal(out, 108, 8, 0);
  octal(out, 116, 8, 0);
  octal(out, 124, 12, size);
  octal(out, 136, 12, 1_700_000_000);
  out.write("        ", 148, 8, "ascii");
  out.write(dir ? "5" : "0", 156, 1, "ascii");
  out.write("ustar\0", 257, 6, "ascii");
  out.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of out) sum += byte;
  out.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return out;
}

/**
 * ファイルの道と中身から、GitHub の tarball と同じ形の tar.gz を組む
 * @param files 木の中の道 (フォルダは / で区切る) と中身
 * @returns tar.gz
 */
export function treeTarball(files: Record<string, string>): Buffer {
  const top = "example-know-office-0000000/";
  const dirs = new Set<string>([top]);
  const parts: Buffer[] = [];
  for (const path of Object.keys(files)) {
    const segments = path.split("/").slice(0, -1);
    for (let i = 1; i <= segments.length; i += 1) dirs.add(`${top}${segments.slice(0, i).join("/")}/`);
  }
  for (const dir of dirs) parts.push(entryHeader(dir, 0, true));
  for (const [path, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    parts.push(entryHeader(`${top}${path}`, body.byteLength, false));
    const data = Buffer.alloc(Math.ceil(body.byteLength / 512) * 512);
    body.copy(data);
    parts.push(data);
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
