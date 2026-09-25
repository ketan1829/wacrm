import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { rescheduleAppointment } from "@/lib/appointments/booking";

/**
 * POST /api/appointments/[id]/reschedule — reschedule appointment creating new linked record.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("agent");
    const body = await request.json();

    const { new_start_at, new_end_at, staff_id, reason } = body;

    if (!new_start_at || !new_end_at) {
      return NextResponse.json(
        { error: "Missing required fields (new_start_at, new_end_at)" },
        { status: 400 },
      );
    }

    const result = await rescheduleAppointment(
      {
        appointmentId: id,
        accountId: ctx.accountId,
        newStartAt: new_start_at,
        newEndAt: new_end_at,
        staffId: staff_id,
        reason,
        cancelledBy: ctx.userId,
      },
      ctx.supabase,
    );

    if (!result.ok) {
      const status = result.code === "SLOT_ALREADY_BOOKED" ? 409 : 400;
      return NextResponse.json({ error: result.error, code: result.code }, { status });
    }

    return NextResponse.json({ appointment: result.appointment });
  } catch (err) {
    return toErrorResponse(err);
  }
}
