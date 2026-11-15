// 社員の姿の元。VRM のモデルを指した社員はそれを読み、指していない社員は形を組み合わせた姿にする

/** 社員の id から VRM のモデルの URL。モデルを置いたら、ここに足す */
export const VRM_MODELS: Readonly<Record<string, string>> = {};

/** 社員の姿の元 */
export type AvatarSource = { kind: "shapes" } | { kind: "vrm"; url: string };

/**
 * 社員の姿の元を決める
 * @param staffId 社員の id
 * @param models 社員の id から VRM の URL
 * @returns 姿の元
 */
export function avatarSourceOf(staffId: string, models: Readonly<Record<string, string>> = VRM_MODELS): AvatarSource {
  const url = models[staffId];
  return url ? { kind: "vrm", url } : { kind: "shapes" };
}
