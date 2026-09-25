import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { processAppointmentReminders } from "@/lib/appointments/reminders";

/**
 * POST /api/appointments/reminders/process
 * Triggers 24-hour and 2-hour appointment reminder scanning and sending.
 * Supports session auth (dashboard user) or cron secret header.
 */
export async function POST(request: Request) {
  try {
    const cronSecret = process.env.AUTOMATION_CRON_SECRET;
    const supplied = request.headers.get("x-cron-secret");

    let accountId: string | undefined;

    if (cronSecret && supplied) {
      const suppliedBuf = Buffer.from(supplied);
      const expectedBuf = Buffer.from(cronSecret);
      if (
        suppliedBuf.length === expectedBuf.length &&
        timingSafeEqual(suppliedBuf, expectedBuf)
      ) {
        // Cron auth verified - allow optional accountId from body or query
        const url = new URL(request.url);
        accountId = url.searchParams.get("accountId") ?? undefined;
      } else {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    } else {
      const ctx = await getCurrentAccount();
      accountId = ctx.accountId;
    }

    const result = await processAppointmentReminders(accountId);
    return NextResponse.json({ success: true, result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
