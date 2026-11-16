// 開発の通しが社員の勤怠を同じ日に流し直すための道。development で代わりの物が手元にある時だけ受け、ほかの環境ではゲートウェイに任せる (社員と勤怠の 3.1、ログインと記録の 3.9)
import { type Clock, StaffId } from "@know-office/core";
import { devWorkspaceBase } from "../endpoints.ts";
import type { Bindings } from "../env.ts";

/** 退勤した日の印を消す道。/__dev/staff/<社員 ID>/forget-day */
const FORGET_DAY = /^\/__dev\/staff\/([^/]+)\/forget-day$/;

/**
 * 開発の通しが送った、社員の退勤した日の印を消す要求を受ける。同じ日に一度退勤した社員はその日にもう出勤しないので、手元の DO を使い回して同じ日に流し直す通しがこれで出勤させる
 * @param request 入口に届いた要求
 * @param env バインディング
 * @param options 時刻
 * @param options.clock 今の時刻
 * @returns 返事。development でない時か、この道でない時は null で、ゲートウェイに任せる
 */
export function devStaffRoute(request: Request, env: Bindings, options: { clock: Clock }): Promise<Response> | null {
  const match = FORGET_DAY.exec(new URL(request.url).pathname);
  if (!match || env.ENVIRONMENT !== "development") return null;
  // DEV_FAKES_URL が手元でなければ、開発の通しも無いので受けない
  try {
    devWorkspaceBase(env);
  } catch {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  const staffId = StaffId.safeParse(match[1]);
  if (!staffId.success || request.method !== "POST") return Promise.resolve(new Response(null, { status: 404 }));
  return env.STAFF.get(env.STAFF.idFromName(staffId.data))
    .forgetDay(options.clock.now())
    .then(() => new Response(null, { status: 204 }));
}
