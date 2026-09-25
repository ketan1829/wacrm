import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { createAppointment } from "@/lib/appointments/booking";

/**
 * GET /api/appointments — list appointments for the account with optional filters.
 * POST /api/appointments — create a new appointment via the booking engine.
 */

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);

    const startDate = searchParams.get("start_date");
    const endDate = searchParams.get("end_date");
    const staffId = searchParams.get("staff_id");
    const serviceId = searchParams.get("service_id");
    const contactId = searchParams.get("contact_id");
    const status = searchParams.get("status");

    let query = ctx.supabase
      .from("appointments")
      .select("*, service:appointment_services(*), staff:appointment_staff(*), contact:contacts(*)")
      .eq("account_id", ctx.accountId)
      .order("start_at", { ascending: true });

    if (startDate) {
      query = query.gte("start_at", new Date(startDate).toISOString());
    }
    if (endDate) {
      query = query.lte("start_at", new Date(endDate).toISOString());
    }
    if (staffId) {
      query = query.eq("staff_id", staffId);
    }
    if (serviceId) {
      query = query.eq("service_id", serviceId);
    }
    if (contactId) {
      query = query.eq("contact_id", contactId);
    }
    if (status) {
      query = query.eq("status", status);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ appointments: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = await request.json();

    const {
      service_id,
      staff_id,
      start_at,
      end_at,
      customer_name,
      customer_phone,
      timezone,
      contact_id,
      conversation_id,
      notes,
      source,
      status,
    } = body;

    if (!service_id || !staff_id || !start_at || !end_at || !customer_name || !customer_phone) {
      return NextResponse.json(
        { error: "Missing required fields (service_id, staff_id, start_at, end_at, customer_name, customer_phone)" },
        { status: 400 },
      );
    }

    const result = await createAppointment(
      {
        accountId: ctx.accountId,
        serviceId: service_id,
        staffId: staff_id,
        startAt: start_at,
        endAt: end_at,
        customerName: customer_name,
        customerPhone: customer_phone,
        timezone: timezone || "Asia/Kolkata",
        contactId: contact_id,
        conversationId: conversation_id,
        notes,
        source: source || "dashboard",
        status: status || "confirmed",
        createdBy: ctx.userId,
      },
      ctx.supabase,
    );

    if (!result.ok) {
      const statusCode = result.code === "SLOT_ALREADY_BOOKED" ? 409 : 400;
      return NextResponse.json({ error: result.error, code: result.code }, { status: statusCode });
    }

    return NextResponse.json({ appointment: result.appointment }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
