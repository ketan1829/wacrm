import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";

/**
 * GET, PATCH, DELETE /api/appointments/staff/[id]
 */

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await getCurrentAccount();

    const [{ data: staff, error: staffErr }, { data: services }] = await Promise.all([
      ctx.supabase
        .from("appointment_staff")
        .select("*")
        .eq("id", id)
        .eq("account_id", ctx.accountId)
        .single(),
      ctx.supabase
        .from("appointment_staff_services")
        .select("service_id")
        .eq("staff_id", id),
    ]);

    if (staffErr || !staff) {
      return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
    }

    const serviceIds = (services || []).map((s: { service_id: string }) => s.service_id);

    return NextResponse.json({ staff: { ...staff, service_ids: serviceIds } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");
    const body = await request.json();

    const allowedFields = ["name", "email", "phone", "user_id", "color", "is_active"];
    const updates: Record<string, unknown> = {};

    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    const { data: staff, error } = await ctx.supabase
      .from("appointment_staff")
      .update(updates)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Update service mappings if provided
    if (Array.isArray(body.service_ids)) {
      await ctx.supabase.from("appointment_staff_services").delete().eq("staff_id", id);

      if (body.service_ids.length > 0) {
        const mappings = body.service_ids.map((serviceId: string) => ({
          staff_id: id,
          service_id: serviceId,
        }));
        await ctx.supabase.from("appointment_staff_services").insert(mappings);
      }
    }

    return NextResponse.json({ staff: { ...staff, service_ids: body.service_ids } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");

    const { error } = await ctx.supabase
      .from("appointment_staff")
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
