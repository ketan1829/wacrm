import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * GET /api/appointments/staff — list staff with linked services.
 * POST /api/appointments/staff — create staff member (admin+).
 */

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const [{ data: staff, error: staffErr }, { data: staffServices, error: ssErr }] =
      await Promise.all([
        ctx.supabase
          .from("appointment_staff")
          .select("*")
          .eq("account_id", ctx.accountId)
          .order("name", { ascending: true }),
        ctx.supabase.from("appointment_staff_services").select("staff_id, service_id"),
      ]);

    if (staffErr) {
      return NextResponse.json({ error: staffErr.message }, { status: 500 });
    }

    const servicesByStaff = new Map<string, string[]>();
    for (const ss of staffServices || []) {
      const list = servicesByStaff.get(ss.staff_id) || [];
      list.push(ss.service_id);
      servicesByStaff.set(ss.staff_id, list);
    }

    const hydrated = (staff || []).map((s) => ({
      ...s,
      service_ids: servicesByStaff.get(s.id) || [],
    }));

    return NextResponse.json({ staff: hydrated });
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
      email,
      phone,
      user_id,
      color = "#3b82f6",
      is_active = true,
      service_ids = [],
    } = body;

    if (!name) {
      return NextResponse.json({ error: "Staff name is required" }, { status: 400 });
    }

    const { data: staffMember, error } = await ctx.supabase
      .from("appointment_staff")
      .insert({
        account_id: ctx.accountId,
        name,
        email: email || null,
        phone: phone || null,
        user_id: user_id || null,
        color,
        is_active,
      })
      .select("*")
      .single();

    if (error || !staffMember) {
      return NextResponse.json({ error: error?.message || "Failed to create staff" }, { status: 500 });
    }

    // Insert staff ↔ service mappings
    if (Array.isArray(service_ids) && service_ids.length > 0) {
      const mappings = service_ids.map((serviceId: string) => ({
        staff_id: staffMember.id,
        service_id: serviceId,
      }));
      await ctx.supabase.from("appointment_staff_services").insert(mappings);
    }

    return NextResponse.json({ staff: { ...staffMember, service_ids } }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
