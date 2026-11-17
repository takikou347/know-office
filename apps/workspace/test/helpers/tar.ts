// テストで渡す木の tar.gz を作る。シンボリックリンク、ハードリンク、デバイス、fifo、.. の道を自由に入れるため、ustar の枠を手で組む
import { gzipSync } from "node:zlib";

/** tar の 1 件 */
export type TarEntry = {
  /** 道。GitHub の tarball と同じく頭に 1 段のフォルダを付けて渡す */
  name: string;
  /** 種類。省くと通常のファイル */
  type?: "file" | "dir" | "hardlink" | "symlink" | "char" | "block" | "fifo";
  /** 中身。通常のファイルだけ */
  body?: string | Buffer;
  /** リンクの先 */
  link?: string;
  /** 宣言する大きさ。省くと中身の長さ。中身より大きくすると中身を 0 で埋める */
  size?: number;
};

const TYPE_FLAG = { file: "0", hardlink: "1", symlink: "2", char: "3", block: "4", dir: "5", fifo: "6" } as const;

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
 * tar を組む
 * @param entries 件の並び
 * @param tail 終わりの印の後に足す 0 の長さ
 * @returns tar の中身
 */
export function tar(entries: TarEntry[], tail = 0): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : (entry.body ?? Buffer.alloc(0));
    const size = type === "file" ? (entry.size ?? body.byteLength) : 0;
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    octal(header, 100, 8, type === "dir" ? 0o755 : 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, size);
    octal(header, 136, 12, 1_700_000_000);
    header.write("        ", 148, 8, "ascii");
    header.write(TYPE_FLAG[type], 156, 1, "ascii");
    header.write(entry.link ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    parts.push(header);
    if (size > 0) {
      const data = Buffer.alloc(Math.ceil(size / 512) * 512);
      body.copy(data);
      parts.push(data);
    }
  }
  parts.push(Buffer.alloc(1024 + tail));
  return Buffer.concat(parts);
}

/**
 * tar.gz を組む
 * @param entries 件の並び
 * @param tail 終わりの印の後に足す 0 の長さ
 * @returns tar.gz の中身
 */
export function tarGz(entries: TarEntry[], tail = 0): Buffer {
  return gzipSync(tar(entries, tail), { level: 1 });
}
