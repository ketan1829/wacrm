import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { processAppointmentReminders } from "@/lib/appointments/reminders";

/**
 * Sweep upcoming appointments to send 24-hour and 2-hour reminders.
 *
 * Meant to be hit on a schedule (Vercel Cron / GitHub Actions / external pinger)
 * — requires a shared secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * Scans all confirmed appointments across accounts where reminder_sent_24h
 * or reminder_sent_2h is false and dispatches reminders.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }

  const supplied = request.headers.get("x-cron-secret") ?? "";
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await processAppointmentReminders();
  return NextResponse.json({ success: true, ...result });
}
