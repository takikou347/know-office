// 画面の中を移る口と、拡張を入れるか切る口の型。App が作り、各画面に渡す

/** 画面の中の道へ移る。replace なら履歴を足さない */
export type Navigate = (to: string, opts?: { replace?: boolean }) => void;

/** 拡張を入れるか切る。入口の返事で一覧を直す */
export type ToggleExtension = (id: string, enabled: boolean) => Promise<void>;
