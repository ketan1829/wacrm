import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { getAvailableSlots, getAvailableDates } from "@/lib/appointments/availability";

/**
 * GET /api/appointments/availability
 * Finds real-time available slots and dates.
 * Used by Flows, Calendar UI, AI Agent, and APIs.
 */
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);

    const serviceId = searchParams.get("service_id");
    const staffId = searchParams.get("staff_id") || undefined;
    const date = searchParams.get("date");
    const mode = searchParams.get("mode") || (date ? "slots" : "dates");
    const timezone = searchParams.get("timezone") || "Asia/Kolkata";
    const days = parseInt(searchParams.get("days") || "14", 10);

    if (!serviceId) {
      return NextResponse.json({ error: "service_id parameter is required" }, { status: 400 });
    }

    if (mode === "dates") {
      const dates = await getAvailableDates({
        accountId: ctx.accountId,
        serviceId,
        staffId,
        daysCount: days,
        timezone,
        client: ctx.supabase,
      });

      return NextResponse.json({ dates });
    }

    if (!date) {
      return NextResponse.json({ error: "date parameter is required for slots lookup" }, { status: 400 });
    }

    const slotResult = await getAvailableSlots({
      accountId: ctx.accountId,
      serviceId,
      staffId,
      date,
      timezone,
      client: ctx.supabase,
    });

    return NextResponse.json(slotResult);
  } catch (err) {
    return toErrorResponse(err);
  }
}
