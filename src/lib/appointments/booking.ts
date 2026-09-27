import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./admin-client";
import { hasStaffConflict } from "./conflicts";
import {
  canTransitionStatus,
  getActionableErrorMessage,
  type AppointmentErrorCode,
} from "./status";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { findExistingContact } from "@/lib/contacts/dedupe";
import type {
  Appointment,
  CreateAppointmentInput,
  RescheduleAppointmentInput,
  CancelAppointmentInput,
  AppointmentStatus,
  BookingResult,
} from "./types";

/**
 * Creates an appointment using atomic RPC locking or transactional conflict validation.
 * Guaranteed double-booking protection.
 * Supports explicit staff or atomic "Any Provider" assignment when staffId is null/omitted.
 */
export async function createAppointment(
  input: CreateAppointmentInput,
  client?: SupabaseClient,
): Promise<BookingResult> {
  const db = client ?? supabaseAdmin();

  const start = new Date(input.startAt);
  const end = new Date(input.endAt);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      error: getActionableErrorMessage("INVALID_TIME_RANGE"),
    };
  }

  // 1. Resolve or find contact if phone provided
  let contactId = input.contactId ?? null;
  if (!contactId && input.customerPhone) {
    try {
      const existing = await findExistingContact(
        db,
        input.accountId,
        input.customerPhone,
      );
      if (existing) {
        contactId = existing.id;
      } else {
        // Create lightweight contact record
        const { data: newContact } = await db
          .from("contacts")
          .insert({
            account_id: input.accountId,
            name: input.customerName,
            phone: input.customerPhone,
          })
          .select("id")
          .single();
        if (newContact) contactId = newContact.id;
      }
    } catch (e) {
      console.warn("[createAppointment] contact resolution error:", e);
    }
  }

  const effectiveStaffId =
    input.staffId && input.staffId !== "any" ? input.staffId : null;

  // 2. Try atomic RPC first (book_appointment_atomic)
  try {
    const { data: rpcResult, error: rpcError } = await db.rpc("book_appointment_atomic", {
      p_account_id: input.accountId,
      p_service_id: input.serviceId,
      p_staff_id: effectiveStaffId,
      p_start_at: start.toISOString(),
      p_end_at: end.toISOString(),
      p_customer_name: input.customerName,
      p_customer_phone: input.customerPhone,
      p_timezone: input.timezone || "Asia/Kolkata",
      p_contact_id: contactId,
      p_conversation_id: input.conversationId ?? null,
      p_notes: input.notes ?? null,
      p_source: input.source || "dashboard",
      p_status: input.status || "confirmed",
      p_created_by: input.createdBy ?? null,
    });

    if (!rpcError && rpcResult) {
      if (!rpcResult.ok) {
        const code = (rpcResult.error as AppointmentErrorCode) || "DATABASE_ERROR";
        return {
          ok: false,
          code,
          error: getActionableErrorMessage(code, rpcResult.error),
        };
      }

      let createdAppointment = rpcResult.appointment as Appointment;

      if (!createdAppointment.service || !createdAppointment.staff) {
        const { data: fullApp } = await db
          .from("appointments")
          .select("*, service:appointment_services(*), staff:appointment_staff(*)")
          .eq("id", createdAppointment.id)
          .maybeSingle();
        if (fullApp) {
          createdAppointment = fullApp as Appointment;
        }
      }

      // Fire appointment_created automation in background
      dispatchAppointmentAutomation({
        accountId: input.accountId,
        triggerType: "appointment_created",
        contactId,
        appointment: createdAppointment,
      });

      return { ok: true, appointment: createdAppointment };
    }
  } catch (rpcErr) {
    console.warn("[createAppointment] RPC failed, falling back to direct check/insert:", rpcErr);
  }

  // 3. Fallback direct verification + insert
  let assignedStaffId = effectiveStaffId;

  if (!assignedStaffId) {
    // Pick first eligible active staff with no conflict
    const { data: mappedStaff } = await db
      .from("appointment_staff_services")
      .select("staff_id")
      .eq("service_id", input.serviceId);

    const mappedIds = (mappedStaff || []).map((m: { staff_id: string }) => m.staff_id);

    let staffQuery = db
      .from("appointment_staff")
      .select("id")
      .eq("account_id", input.accountId)
      .eq("is_active", true);

    if (mappedIds.length > 0) {
      staffQuery = staffQuery.in("id", mappedIds);
    }

    const { data: staffCandidates } = await staffQuery;
    for (const cand of staffCandidates || []) {
      const conflict = await hasStaffConflict({
        accountId: input.accountId,
        staffId: cand.id,
        startAt: start,
        endAt: end,
        client: db,
      });
      if (!conflict) {
        assignedStaffId = cand.id;
        break;
      }
    }
  }

  if (!assignedStaffId) {
    return {
      ok: false,
      code: "SLOT_ALREADY_BOOKED",
      error: getActionableErrorMessage("SLOT_ALREADY_BOOKED"),
    };
  }

  const conflict = await hasStaffConflict({
    accountId: input.accountId,
    staffId: assignedStaffId,
    startAt: start,
    endAt: end,
    client: db,
  });

  if (conflict) {
    return {
      ok: false,
      code: "SLOT_ALREADY_BOOKED",
      error: getActionableErrorMessage("SLOT_ALREADY_BOOKED"),
    };
  }

  const { data: newRow, error: insertError } = await db
    .from("appointments")
    .insert({
      account_id: input.accountId,
      contact_id: contactId,
      conversation_id: input.conversationId ?? null,
      service_id: input.serviceId,
      staff_id: assignedStaffId,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      timezone: input.timezone || "Asia/Kolkata",
      status: input.status || "confirmed",
      source: input.source || "dashboard",
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      notes: input.notes ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("*, service:appointment_services(*), staff:appointment_staff(*)")
    .single();

  if (insertError) {
    if (
      insertError.code === "23P01" ||
      insertError.message.includes("no_overlapping_staff_appointments")
    ) {
      return {
        ok: false,
        code: "SLOT_ALREADY_BOOKED",
        error: getActionableErrorMessage("SLOT_ALREADY_BOOKED"),
      };
    }
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: insertError.message,
    };
  }

  dispatchAppointmentAutomation({
    accountId: input.accountId,
    triggerType: "appointment_created",
    contactId,
    appointment: newRow as Appointment,
  });

  return { ok: true, appointment: newRow as Appointment };
}

/**
 * Reschedules an appointment atomically:
 *   - Verifies old appointment is reschedulable (pending or confirmed)
 *   - Verifies target slot availability
 *   - Inserts new appointment row linked to old appointment
 *   - Marks old appointment as 'rescheduled' with rescheduled_at and reschedule_reason
 *   - Preserves cancellation fields strictly for actual cancellations
 */
export async function rescheduleAppointment(
  input: RescheduleAppointmentInput,
  client?: SupabaseClient,
): Promise<BookingResult> {
  const db = client ?? supabaseAdmin();
  const rescheduleReason = input.rescheduleReason || input.reason || "Rescheduled";

  // 1. Fetch old appointment to validate status transition
  const { data: oldApp, error: fetchErr } = await db
    .from("appointments")
    .select("*")
    .eq("id", input.appointmentId)
    .eq("account_id", input.accountId)
    .single();

  if (fetchErr || !oldApp) {
    return {
      ok: false,
      code: "NOT_FOUND",
      error: getActionableErrorMessage("NOT_FOUND"),
    };
  }

  if (!canTransitionStatus(oldApp.status as AppointmentStatus, "rescheduled")) {
    return {
      ok: false,
      code: "APPOINTMENT_NOT_RESCHEDULABLE",
      error: `Cannot reschedule an appointment that is currently ${oldApp.status}`,
    };
  }

  const newStart = new Date(input.newStartAt);
  const newEnd = new Date(input.newEndAt);

  if (isNaN(newStart.getTime()) || isNaN(newEnd.getTime()) || newEnd <= newStart) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      error: getActionableErrorMessage("INVALID_TIME_RANGE"),
    };
  }

  const targetStaffId = input.staffId || oldApp.staff_id;

  // 2. Attempt atomic RPC reschedule
  try {
    const { data: rpcResult, error: rpcError } = await db.rpc(
      "reschedule_appointment_atomic",
      {
        p_account_id: input.accountId,
        p_appointment_id: input.appointmentId,
        p_new_start_at: newStart.toISOString(),
        p_new_end_at: newEnd.toISOString(),
        p_staff_id: targetStaffId,
        p_reschedule_reason: rescheduleReason,
      },
    );

    if (!rpcError && rpcResult) {
      if (!rpcResult.ok) {
        const code = (rpcResult.error as AppointmentErrorCode) || "DATABASE_ERROR";
        return {
          ok: false,
          code,
          error: getActionableErrorMessage(code, rpcResult.error),
        };
      }

      let newApp = rpcResult.appointment as Appointment;

      if (!newApp.service || !newApp.staff) {
        const { data: fullApp } = await db
          .from("appointments")
          .select("*, service:appointment_services(*), staff:appointment_staff(*)")
          .eq("id", newApp.id)
          .maybeSingle();
        if (fullApp) {
          newApp = fullApp as Appointment;
        }
      }

      dispatchAppointmentAutomation({
        accountId: input.accountId,
        triggerType: "appointment_created",
        contactId: oldApp.contact_id,
        appointment: newApp,
      });

      return { ok: true, appointment: newApp };
    }
  } catch (rpcErr) {
    console.warn("[rescheduleAppointment] atomic RPC failed, falling back to direct transaction:", rpcErr);
  }

  // 3. Fallback direct verification + insert
  const conflict = await hasStaffConflict({
    accountId: input.accountId,
    staffId: targetStaffId,
    startAt: newStart,
    endAt: newEnd,
    excludeAppointmentId: oldApp.id,
    client: db,
  });

  if (conflict) {
    return {
      ok: false,
      code: "SLOT_ALREADY_BOOKED",
      error: getActionableErrorMessage("SLOT_ALREADY_BOOKED"),
    };
  }

  const { data: newApp, error: insertErr } = await db
    .from("appointments")
    .insert({
      account_id: input.accountId,
      contact_id: oldApp.contact_id,
      conversation_id: oldApp.conversation_id,
      service_id: oldApp.service_id,
      staff_id: targetStaffId,
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      timezone: oldApp.timezone,
      status: "confirmed",
      source: oldApp.source,
      customer_name: oldApp.customer_name,
      customer_phone: oldApp.customer_phone,
      notes: oldApp.notes,
      rescheduled_from_id: oldApp.id,
      created_by: oldApp.created_by,
    })
    .select("*, service:appointment_services(*), staff:appointment_staff(*)")
    .single();

  if (insertErr || !newApp) {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      error: insertErr?.message || "Failed to create rescheduled appointment",
    };
  }

  // Mark old appointment as rescheduled (explicitly NOT touching cancelled_at/cancelled_by)
  await db
    .from("appointments")
    .update({
      status: "rescheduled",
      rescheduled_to_id: newApp.id,
      rescheduled_at: new Date().toISOString(),
      reschedule_reason: rescheduleReason,
    })
    .eq("id", oldApp.id);

  dispatchAppointmentAutomation({
    accountId: input.accountId,
    triggerType: "appointment_created",
    contactId: oldApp.contact_id,
    appointment: newApp as Appointment,
  });

  return { ok: true, appointment: newApp as Appointment };
}

/**
 * Cancels an appointment, recording the reason, timestamp, and actor.
 * Never deletes the historical appointment row.
 */
export async function cancelAppointment(
  input: CancelAppointmentInput,
  client?: SupabaseClient,
): Promise<{ ok: boolean; error?: string; code?: AppointmentErrorCode }> {
  const db = client ?? supabaseAdmin();

  const { data: oldApp } = await db
    .from("appointments")
    .select("id, contact_id, status")
    .eq("id", input.appointmentId)
    .eq("account_id", input.accountId)
    .single();

  if (!oldApp) {
    return {
      ok: false,
      code: "NOT_FOUND",
      error: getActionableErrorMessage("NOT_FOUND"),
    };
  }

  if (!canTransitionStatus(oldApp.status as AppointmentStatus, "cancelled")) {
    return {
      ok: false,
      code: "INVALID_STATUS_TRANSITION",
      error: `Cannot cancel an appointment that is currently ${oldApp.status}`,
    };
  }

  const { error } = await db
    .from("appointments")
    .update({
      status: "cancelled",
      cancellation_reason: input.reason ?? null,
      cancelled_by: input.cancelledBy ?? "user",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", input.appointmentId)
    .eq("account_id", input.accountId);

  if (error) {
    return { ok: false, code: "DATABASE_ERROR", error: error.message };
  }

  dispatchAppointmentAutomation({
    accountId: input.accountId,
    triggerType: "appointment_cancelled",
    contactId: oldApp.contact_id,
    appointment: { id: input.appointmentId, status: "cancelled" } as Appointment,
  });

  return { ok: true };
}

/**
 * Updates an appointment's status (completed, no_show, confirmed).
 * Enforces centralized lifecycle transition rules.
 */
export async function updateAppointmentStatus(
  appointmentId: string,
  accountId: string,
  newStatus: AppointmentStatus,
  client?: SupabaseClient,
): Promise<{ ok: boolean; error?: string; code?: AppointmentErrorCode }> {
  const db = client ?? supabaseAdmin();

  const { data: currentApp } = await db
    .from("appointments")
    .select("id, status")
    .eq("id", appointmentId)
    .eq("account_id", accountId)
    .single();

  if (!currentApp) {
    return {
      ok: false,
      code: "NOT_FOUND",
      error: getActionableErrorMessage("NOT_FOUND"),
    };
  }

  if (!canTransitionStatus(currentApp.status as AppointmentStatus, newStatus)) {
    return {
      ok: false,
      code: "INVALID_STATUS_TRANSITION",
      error: `Cannot change status from ${currentApp.status} to ${newStatus}`,
    };
  }

  const { error } = await db
    .from("appointments")
    .update({ status: newStatus })
    .eq("id", appointmentId)
    .eq("account_id", accountId);

  if (error) {
    return { ok: false, code: "DATABASE_ERROR", error: error.message };
  }

  return { ok: true };
}

/**
 * Background helper to trigger automations for appointment events.
 */
function dispatchAppointmentAutomation({
  accountId,
  triggerType,
  contactId,
  appointment,
}: {
  accountId: string;
  triggerType: "appointment_created" | "appointment_cancelled" | "appointment_reminder";
  contactId?: string | null;
  appointment: Appointment;
}) {
  if (!contactId) return;

  runAutomationsForTrigger({
    accountId,
    triggerType,
    contactId,
    context: {
      vars: {
        appointment_id: appointment.id,
        appointment_service: appointment.service?.name,
        appointment_staff: appointment.staff?.name,
        appointment_start_at: appointment.start_at,
        appointment_end_at: appointment.end_at,
        appointment_status: appointment.status,
      },
    },
  }).catch((err) => {
    console.warn(`[dispatchAppointmentAutomation] ${triggerType} failed:`, err);
  });
}
