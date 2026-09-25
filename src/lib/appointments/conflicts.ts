import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./admin-client";

export interface ConflictCheckParams {
  accountId: string;
  staffId: string;
  startAt: string | Date;
  endAt: string | Date;
  excludeAppointmentId?: string;
  client?: SupabaseClient;
}

/**
 * Check if a staff member has an overlapping appointment in the given interval.
 * Checks active appointments (pending, confirmed).
 */
export async function hasStaffConflict({
  accountId,
  staffId,
  startAt,
  endAt,
  excludeAppointmentId,
  client,
}: ConflictCheckParams): Promise<boolean> {
  const db = client ?? supabaseAdmin();

  const startIso = typeof startAt === "string" ? startAt : startAt.toISOString();
  const endIso = typeof endAt === "string" ? endAt : endAt.toISOString();

  let query = db
    .from("appointments")
    .select("id, start_at, end_at, status")
    .eq("account_id", accountId)
    .eq("staff_id", staffId)
    .in("status", ["pending", "confirmed"])
    // Overlap condition: appointment.start_at < new.end_at AND appointment.end_at > new.start_at
    .lt("start_at", endIso)
    .gt("end_at", startIso);

  if (excludeAppointmentId) {
    query = query.neq("id", excludeAppointmentId);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[hasStaffConflict] conflict check failed:", error);
    // Be conservative: if check fails, assume conflict
    return true;
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Checks whether two time intervals overlap.
 * [startA, endA) and [startB, endB)
 */
export function intervalsOverlap(
  startA: Date | number,
  endA: Date | number,
  startB: Date | number,
  endB: Date | number,
): boolean {
  const a1 = typeof startA === "number" ? startA : startA.getTime();
  const a2 = typeof endA === "number" ? endA : endA.getTime();
  const b1 = typeof startB === "number" ? startB : startB.getTime();
  const b2 = typeof endB === "number" ? endB : endB.getTime();

  return a1 < b2 && a2 > b1;
}
