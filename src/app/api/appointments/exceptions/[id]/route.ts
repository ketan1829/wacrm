import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * DELETE /api/appointments/exceptions/[id]
 */

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");

    const { error } = await ctx.supabase
      .from("appointment_availability_exceptions")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
