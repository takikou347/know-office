/**
 * ログインセッションを確かめないルート。セッションを作る所、D1 が止まっても答える稼働確認、GitHub から戻る所
 * ログインセッションのクッキーは SameSite=Strict なので、github.com から戻る時には付かない。戻る所は Access と、署名した state か GitHub への問い合わせで確かめる
 * 入口のミドルウェアと、全ルートに当てる守りのテスト (単体と e2e) がここを読む。ほかを読み込まないので、Playwright からも読める
 */
export const WITHOUT_SESSION: ReadonlySet<string> = new Set(["POST /api/v1/sessions", "GET /api/v1/health", "GET /api/v1/github/callback", "GET /api/v1/github/installed"]);
