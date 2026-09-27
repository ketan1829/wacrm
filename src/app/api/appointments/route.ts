import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { createAppointment } from "@/lib/appointments/booking";

/**
 * GET /api/appointments — list appointments for the account with optional filters.
 * Validates date ranges to prevent accidental excessive full-table loads.
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

    // Date range validation
    let startIso: string | undefined;
    let endIso: string | undefined;

    if (startDate) {
      const sStr = startDate.includes("T") ? startDate : `${startDate}T00:00:00.000Z`;
      const s = new Date(sStr);
      if (isNaN(s.getTime())) {
        return NextResponse.json({ error: "Invalid start_date parameter" }, { status: 400 });
      }
      startIso = s.toISOString();
    }

    if (endDate) {
      const eStr = endDate.includes("T") ? endDate : `${endDate}T23:59:59.999Z`;
      const e = new Date(eStr);
      if (isNaN(e.getTime())) {
        return NextResponse.json({ error: "Invalid end_date parameter" }, { status: 400 });
      }
      endIso = e.toISOString();
    }

    if (startIso && endIso) {
      const sTime = new Date(startIso).getTime();
      const eTime = new Date(endIso).getTime();
      if (eTime < sTime) {
        return NextResponse.json(
          { error: "end_date must be greater than or equal to start_date" },
          { status: 400 },
        );
      }
      const maxSpanMs = 93 * 24 * 60 * 60 * 1000; // max 93 days (~3 months)
      if (eTime - sTime > maxSpanMs) {
        return NextResponse.json(
          { error: "Date range cannot exceed 93 days" },
          { status: 400 },
        );
      }
    }

    let query = ctx.supabase
      .from("appointments")
      .select("*, service:appointment_services(*), staff:appointment_staff(*), contact:contacts(*)")
      .eq("account_id", ctx.accountId)
      .order("start_at", { ascending: true });

    if (startIso) {
      query = query.gte("end_at", startIso);
    }
    if (endIso) {
      query = query.lte("start_at", endIso);
    }
    if (staffId && staffId !== "all") {
      query = query.eq("staff_id", staffId);
    }
    if (serviceId && serviceId !== "all") {
      query = query.eq("service_id", serviceId);
    }
    if (contactId) {
      query = query.eq("contact_id", contactId);
    }
    if (status && status !== "all") {
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

    if (!service_id || !start_at || !end_at || !customer_name || !customer_phone) {
      return NextResponse.json(
        { error: "Missing required fields (service_id, start_at, end_at, customer_name, customer_phone)" },
        { status: 400 },
      );
    }

    const result = await createAppointment(
      {
        accountId: ctx.accountId,
        serviceId: service_id,
        staffId: staff_id || null, // null triggers atomic Any Provider assignment
        startAt: start_at,
        endAt: end_at,
        customerName: customer_name,
        customerPhone: customer_phone,
        timezone: timezone || "Asia/Kolkata",
        contactId: contact_id || null,
        conversationId: conversation_id || null,
        notes: notes || null,
        source: source || "dashboard",
        status: status || "confirmed",
        createdBy: ctx.userId,
      },
      ctx.supabase,
    );

    if (!result.ok) {
      const statusCode =
        result.code === "SLOT_ALREADY_BOOKED" || result.code === "SLOT_UNAVAILABLE"
          ? 409
          : 400;
      return NextResponse.json({ error: result.error, code: result.code }, { status: statusCode });
    }

    return NextResponse.json({ appointment: result.appointment }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
