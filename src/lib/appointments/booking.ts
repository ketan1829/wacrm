import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./admin-client";
import { hasStaffConflict } from "./conflicts";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { findExistingContact } from "@/lib/contacts/dedupe";
import type {
  Appointment,
  CreateAppointmentInput,
  RescheduleAppointmentInput,
  CancelAppointmentInput,
  AppointmentStatus,
} from "./types";

export interface BookingResult {
  ok: boolean;
  appointment?: Appointment;
  error?: string;
  code?:
    | "SLOT_ALREADY_BOOKED"
    | "SERVICE_NOT_FOUND"
    | "STAFF_NOT_FOUND"
    | "INVALID_TIME_RANGE"
    | "DATABASE_ERROR"
    | "NOT_FOUND";
}

/**
 * Creates an appointment using atomic RPC locking or transactional conflict validation.
 * Guaranteed double-booking protection.
 */
export async function createAppointment(
  input: CreateAppointmentInput,
  client?: SupabaseClient,
): Promise<BookingResult> {
  const db = client ?? supabaseAdmin();

  const start = new Date(input.startAt);
  const end = new Date(input.endAt);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return { ok: false, error: "Invalid appointment start and end times", code: "INVALID_TIME_RANGE" };
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

  // 2. Try atomic RPC first (book_appointment_atomic)
  try {
    const { data: rpcResult, error: rpcError } = await db.rpc("book_appointment_atomic", {
      p_account_id: input.accountId,
      p_service_id: input.serviceId,
      p_staff_id: input.staffId,
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
        if (rpcResult.error === "SLOT_ALREADY_BOOKED") {
          return { ok: false, error: "This time slot has already been reserved", code: "SLOT_ALREADY_BOOKED" };
        }
        if (rpcResult.error === "SERVICE_NOT_FOUND_OR_INACTIVE") {
          return { ok: false, error: "Service not found or inactive", code: "SERVICE_NOT_FOUND" };
        }
        if (rpcResult.error === "STAFF_NOT_FOUND_OR_INACTIVE") {
          return { ok: false, error: "Staff provider not found or inactive", code: "STAFF_NOT_FOUND" };
        }
        return { ok: false, error: rpcResult.error || "Booking failed", code: "DATABASE_ERROR" };
      }

      const createdAppointment = rpcResult.appointment as Appointment;

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
    console.warn("[createAppointment] RPC failed, falling back to direct insert:", rpcErr);
  }

  // Fallback direct check + insert
  const conflict = await hasStaffConflict({
    accountId: input.accountId,
    staffId: input.staffId,
    startAt: start,
    endAt: end,
    client: db,
  });

  if (conflict) {
    return { ok: false, error: "This time slot has already been reserved", code: "SLOT_ALREADY_BOOKED" };
  }

  const { data: newRow, error: insertError } = await db
    .from("appointments")
    .insert({
      account_id: input.accountId,
      contact_id: contactId,
      conversation_id: input.conversationId ?? null,
      service_id: input.serviceId,
      staff_id: input.staffId,
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
    // If exclusion constraint caught a race condition
    if (insertError.code === "23P01" || insertError.message.includes("no_overlapping_staff_appointments")) {
      return { ok: false, error: "This time slot has already been reserved", code: "SLOT_ALREADY_BOOKED" };
    }
    return { ok: false, error: insertError.message, code: "DATABASE_ERROR" };
  }

  // Fire appointment_created automation
  dispatchAppointmentAutomation({
    accountId: input.accountId,
    triggerType: "appointment_created",
    contactId,
    appointment: newRow as Appointment,
  });

  return { ok: true, appointment: newRow as Appointment };
}

/**
 * Reschedules an appointment by marking the old one as 'rescheduled'
 * and creating a new linked appointment row. Preserves full history.
 */
export async function rescheduleAppointment(
  input: RescheduleAppointmentInput,
  client?: SupabaseClient,
): Promise<BookingResult> {
  const db = client ?? supabaseAdmin();

  // 1. Fetch old appointment
  const { data: oldApp, error: fetchErr } = await db
    .from("appointments")
    .select("*")
    .eq("id", input.appointmentId)
    .eq("account_id", input.accountId)
    .single();

  if (fetchErr || !oldApp) {
    return { ok: false, error: "Appointment not found", code: "NOT_FOUND" };
  }

  if (oldApp.status === "cancelled" || oldApp.status === "completed") {
    return {
      ok: false,
      error: `Cannot reschedule an appointment that is already ${oldApp.status}`,
      code: "DATABASE_ERROR",
    };
  }

  const staffId = input.staffId || oldApp.staff_id;
  const newStart = new Date(input.newStartAt);
  const newEnd = new Date(input.newEndAt);

  // 2. Check conflict for new time slot (excluding old appointment)
  const conflict = await hasStaffConflict({
    accountId: input.accountId,
    staffId,
    startAt: newStart,
    endAt: newEnd,
    excludeAppointmentId: oldApp.id,
    client: db,
  });

  if (conflict) {
    return { ok: false, error: "The new time slot has already been reserved", code: "SLOT_ALREADY_BOOKED" };
  }

  // 3. Insert new appointment referencing old
  const { data: newApp, error: insertErr } = await db
    .from("appointments")
    .insert({
      account_id: input.accountId,
      contact_id: oldApp.contact_id,
      conversation_id: oldApp.conversation_id,
      service_id: oldApp.service_id,
      staff_id: staffId,
      start_at: newStart.toISOString(),
      end_at: newEnd.toISOString(),
      timezone: oldApp.timezone,
      status: "confirmed",
      source: oldApp.source,
      customer_name: oldApp.customer_name,
      customer_phone: oldApp.customer_phone,
      notes: input.reason
        ? `Rescheduled from ${oldApp.start_at}. Reason: ${input.reason}`
        : oldApp.notes,
      rescheduled_from_id: oldApp.id,
      created_by: oldApp.created_by,
    })
    .select("*, service:appointment_services(*), staff:appointment_staff(*)")
    .single();

  if (insertErr || !newApp) {
    return { ok: false, error: insertErr?.message || "Failed to create new appointment", code: "DATABASE_ERROR" };
  }

  // 4. Mark old appointment as rescheduled
  await db
    .from("appointments")
    .update({
      status: "rescheduled",
      rescheduled_to_id: newApp.id,
      cancellation_reason: input.reason ?? "Rescheduled",
      cancelled_by: input.cancelledBy ?? "user",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", oldApp.id);

  // Fire appointment_created automation for new appointment
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
 */
export async function cancelAppointment(
  input: CancelAppointmentInput,
  client?: SupabaseClient,
): Promise<{ ok: boolean; error?: string }> {
  const db = client ?? supabaseAdmin();

  const { data: oldApp } = await db
    .from("appointments")
    .select("id, contact_id, status")
    .eq("id", input.appointmentId)
    .eq("account_id", input.accountId)
    .single();

  if (!oldApp) {
    return { ok: false, error: "Appointment not found" };
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
    return { ok: false, error: error.message };
  }

  // Fire appointment_cancelled automation
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
 */
export async function updateAppointmentStatus(
  appointmentId: string,
  accountId: string,
  status: AppointmentStatus,
  client?: SupabaseClient,
): Promise<{ ok: boolean; error?: string }> {
  const db = client ?? supabaseAdmin();

  const { error } = await db
    .from("appointments")
    .update({ status })
    .eq("id", appointmentId)
    .eq("account_id", accountId);

  if (error) {
    return { ok: false, error: error.message };
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

  // Run in background without blocking response
  Promise.resolve().then(async () => {
    try {
      await runAutomationsForTrigger({
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
      });
    } catch (e) {
      console.warn("[dispatchAppointmentAutomation] failed:", e);
    }
  });
}
