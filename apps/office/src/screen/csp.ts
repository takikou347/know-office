// 画面の CSP の nonce を読む。入口 (src/gate/screen-html.ts) が画面の HTML の meta に要求ごとに入れる
/**
 * 画面の HTML の meta から CSP の nonce を読む。部品が差し込む <style> に付けると、CSP の style-src を通る
 * @returns nonce。meta が無い時とサーバーで描く時は undefined
 */
export function pageCspNonce(): string | undefined {
  if (typeof document === "undefined") return undefined;
  // ブラウザーは nonce の属性を読ませないので、属性でなく nonce のプロパティを読む
  return document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce || undefined;
}
