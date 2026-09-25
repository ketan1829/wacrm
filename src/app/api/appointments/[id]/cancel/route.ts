import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { cancelAppointment } from "@/lib/appointments/booking";

/**
 * POST /api/appointments/[id]/cancel — cancel appointment with reason.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("agent");
    const body = await request.json().catch(() => ({}));

    const result = await cancelAppointment(
      {
        appointmentId: id,
        accountId: ctx.accountId,
        reason: body.reason,
        cancelledBy: ctx.userId,
      },
      ctx.supabase,
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Failed to cancel appointment" }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
