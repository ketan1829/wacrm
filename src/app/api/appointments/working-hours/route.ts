import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/appointments/working-hours — list working hours (optional ?staff_id=...)
 * PUT /api/appointments/working-hours — replace working hours for a staff member (admin+)
 */

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const staffId = searchParams.get("staff_id");

    let query = ctx.supabase
      .from("appointment_availability")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    if (staffId) {
      query = query.eq("staff_id", staffId);
    }

    const { data: hours, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ hours: hours ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json();

    const { staff_id, intervals } = body;

    if (!staff_id || !Array.isArray(intervals)) {
      return NextResponse.json(
        { error: "staff_id and intervals array are required" },
        { status: 400 },
      );
    }

    // Replace all existing availability intervals for this staff member
    await ctx.supabase
      .from("appointment_availability")
      .delete()
      .eq("account_id", ctx.accountId)
      .eq("staff_id", staff_id);

    if (intervals.length > 0) {
      const rows = intervals.map(
        (int: {
          day_of_week: number;
          start_time: string;
          end_time: string;
          timezone?: string;
        }) => ({
          account_id: ctx.accountId,
          staff_id,
          day_of_week: int.day_of_week,
          start_time: int.start_time,
          end_time: int.end_time,
          timezone: int.timezone || "Asia/Kolkata",
        }),
      );

      const { data: inserted, error } = await ctx.supabase
        .from("appointment_availability")
        .insert(rows)
        .select("*");

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ hours: inserted });
    }

    return NextResponse.json({ hours: [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
