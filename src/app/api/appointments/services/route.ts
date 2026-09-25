import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/appointments/services — list all services.
 * POST /api/appointments/services — create a new service (admin+).
 */

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data: services, error } = await ctx.supabase
      .from("appointment_services")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ services: services ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = await request.json();

    const {
      name,
      description,
      duration_minutes,
      buffer_before_minutes = 0,
      buffer_after_minutes = 0,
      price = 0,
      currency = "INR",
      is_active = true,
    } = body;

    if (!name || !duration_minutes) {
      return NextResponse.json(
        { error: "name and duration_minutes are required" },
        { status: 400 },
      );
    }

    const { data: service, error } = await ctx.supabase
      .from("appointment_services")
      .insert({
        account_id: ctx.accountId,
        name,
        description,
        duration_minutes: parseInt(duration_minutes, 10),
        buffer_before_minutes: parseInt(buffer_before_minutes, 10) || 0,
        buffer_after_minutes: parseInt(buffer_after_minutes, 10) || 0,
        price: parseFloat(price) || 0,
        currency,
        is_active,
      })
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ service }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
