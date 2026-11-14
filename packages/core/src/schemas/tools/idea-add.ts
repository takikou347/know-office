// 3 人のツール idea_add の入力。オーナーの案と同じ形で案を足す (サービスと拡張の 3.1 の 1)
import { CreateIdeaInput } from "../services.ts";

/** idea_add の入力。POST /api/v1/services と同じ形 */
export const IdeaAddTool = CreateIdeaInput;

/** idea_add の入力の型 */
export type IdeaAddTool = CreateIdeaInput;
