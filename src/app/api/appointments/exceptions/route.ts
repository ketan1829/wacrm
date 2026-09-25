import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/appointments/exceptions — list exceptions (holidays, vacations)
 * POST /api/appointments/exceptions — add exception (admin+)
 */

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const staffId = searchParams.get("staff_id");

    let query = ctx.supabase
      .from("appointment_availability_exceptions")
      .select("*, staff:appointment_staff(*)")
      .eq("account_id", ctx.accountId)
      .order("exception_date", { ascending: true });

    if (staffId) {
      query = query.or(`staff_id.eq.${staffId},staff_id.is.null`);
    }

    const { data: exceptions, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ exceptions: exceptions ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json();

    const {
      staff_id,
      exception_date,
      is_unavailable = true,
      start_time,
      end_time,
      reason,
    } = body;

    if (!exception_date) {
      return NextResponse.json({ error: "exception_date is required" }, { status: 400 });
    }

    const { data: exception, error } = await ctx.supabase
      .from("appointment_availability_exceptions")
      .insert({
        account_id: ctx.accountId,
        staff_id: staff_id || null,
        exception_date,
        is_unavailable,
        start_time: is_unavailable ? null : start_time || null,
        end_time: is_unavailable ? null : end_time || null,
        reason: reason || null,
      })
      .select("*, staff:appointment_staff(*)")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ exception }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
