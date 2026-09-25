import { supabaseAdmin } from "./admin-client";
import { formatTimeInTimezone } from "./availability";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { sendTextMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import type { Appointment } from "./types";

export interface ReminderRunResult {
  processed24h: number;
  processed2h: number;
  errors: string[];
}

/**
 * Scans upcoming appointments and sends 24-hour and 2-hour reminders.
 * Can be called by a cron job or scheduled API endpoint.
 */
export async function processAppointmentReminders(
  targetAccountId?: string,
): Promise<ReminderRunResult> {
  const db = supabaseAdmin();
  const now = new Date();
  const result: ReminderRunResult = { processed24h: 0, processed2h: 0, errors: [] };

  // 1. Process 24-hour reminders (appointments between now+23h and now+25h, or <= now+24h)
  const window24hEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();
  const window24hStart = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

  let query24 = db
    .from("appointments")
    .select("*, service:appointment_services(*), staff:appointment_staff(*)")
    .eq("status", "confirmed")
    .eq("reminder_sent_24h", false)
    .gt("start_at", window24hStart)
    .lte("start_at", window24hEnd);

  if (targetAccountId) {
    query24 = query24.eq("account_id", targetAccountId);
  }

  const { data: due24, error: err24 } = await query24;

  if (err24) {
    result.errors.push(`24h query error: ${err24.message}`);
  } else if (due24) {
    for (const app of due24 as Appointment[]) {
      try {
        await sendAppointmentReminder(db, app, "24h");
        await db
          .from("appointments")
          .update({ reminder_sent_24h: true })
          .eq("id", app.id);
        result.processed24h++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`App ${app.id} 24h reminder error: ${msg}`);
      }
    }
  }

  // 2. Process 2-hour reminders (appointments between now and now+2h)
  const window2hEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000 + 15 * 60 * 1000).toISOString();
  const window2hStart = now.toISOString();

  let query2 = db
    .from("appointments")
    .select("*, service:appointment_services(*), staff:appointment_staff(*)")
    .eq("status", "confirmed")
    .eq("reminder_sent_2h", false)
    .gt("start_at", window2hStart)
    .lte("start_at", window2hEnd);

  if (targetAccountId) {
    query2 = query2.eq("account_id", targetAccountId);
  }

  const { data: due2, error: err2 } = await query2;

  if (err2) {
    result.errors.push(`2h query error: ${err2.message}`);
  } else if (due2) {
    for (const app of due2 as Appointment[]) {
      try {
        await sendAppointmentReminder(db, app, "2h");
        await db
          .from("appointments")
          .update({ reminder_sent_2h: true })
          .eq("id", app.id);
        result.processed2h++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`App ${app.id} 2h reminder error: ${msg}`);
      }
    }
  }

  return result;
}

/**
 * Sends a reminder message for an appointment.
 */
async function sendAppointmentReminder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  app: Appointment,
  reminderType: "24h" | "2h",
) {
  // 1. Dispatch automation if contact exists
  if (app.contact_id) {
    try {
      await runAutomationsForTrigger({
        accountId: app.account_id,
        triggerType: "appointment_reminder",
        contactId: app.contact_id,
        context: {
          vars: {
            reminder_type: reminderType,
            appointment_id: app.id,
            appointment_service: app.service?.name,
            appointment_staff: app.staff?.name,
            appointment_start_at: app.start_at,
            appointment_end_at: app.end_at,
          },
        },
      });
    } catch (e) {
      console.warn("[sendAppointmentReminder] automation dispatch error:", e);
    }
  }

  // 2. Also attempt direct WhatsApp message if business has WhatsApp configured and phone number exists
  if (!app.customer_phone) return;

  const { data: waConfig } = await db
    .from("whatsapp_config")
    .select("phone_number_id, access_token")
    .eq("account_id", app.account_id)
    .maybeSingle();

  if (!waConfig?.access_token || !waConfig?.phone_number_id) return;

  const token = decrypt(waConfig.access_token);
  const timeFormatted = formatTimeInTimezone(new Date(app.start_at), app.timezone || "Asia/Kolkata");
  const serviceName = app.service?.name || "Appointment";
  const staffName = app.staff?.name || "our team";

  let body = "";
  if (reminderType === "24h") {
    body = `Hi ${app.customer_name} 👋\n\nReminder: You have an upcoming ${serviceName} with ${staffName} tomorrow at ${timeFormatted}.\n\nReply:\n1️⃣ Confirm\n2️⃣ Reschedule\n3️⃣ Cancel`;
  } else {
    body = `Hi ${app.customer_name} 👋\n\nYour ${serviceName} with ${staffName} is today at ${timeFormatted}. See you soon! 😊`;
  }

  try {
    await sendTextMessage({
      phoneNumberId: waConfig.phone_number_id,
      accessToken: token,
      to: app.customer_phone,
      text: body,
    });
  } catch (err) {
    console.warn("[sendAppointmentReminder] WhatsApp send error:", err);
  }
}
