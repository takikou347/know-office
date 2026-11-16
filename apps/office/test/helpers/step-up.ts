// v1.yaml で x-step-up: true だが、まだ作っていない操作。hardening.test.ts と e2e/attack.spec.ts が同じ物を使う
/** まだ作っていない、パスキーの確認の要る操作。作る時に createRoute の middleware に stepUpGate を置いてここから外す */
export const STEP_UP_NOT_BUILT: ReadonlySet<string> = new Set([]);
