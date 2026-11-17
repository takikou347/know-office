// 画面の Zod の設定。main.tsx が最初に読み、ほかの物が形を確かめる前に済ませる。設定を済ませた z を返す
import { z } from "zod";

// Zod は速くするために new Function を試す。画面の CSP (script-src 'self') はそれを断って securitypolicyviolation を出すので、試さない形にする
z.config({ jitless: true });

export { z };
