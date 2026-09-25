import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./admin-client";
import type {
  AppointmentService,
  AppointmentStaff,
  AppointmentAvailability,
  AppointmentAvailabilityException,
  TimeSlot,
  AvailableDate,
} from "./types";

export interface GetAvailableSlotsParams {
  accountId: string;
  serviceId: string;
  staffId?: string | null;
  date: string; // "YYYY-MM-DD"
  timezone?: string;
  client?: SupabaseClient;
}

export interface GetAvailableDatesParams {
  accountId: string;
  serviceId: string;
  staffId?: string | null;
  startDate?: string; // "YYYY-MM-DD", defaults to today
  daysCount?: number; // defaults to 14
  timezone?: string;
  client?: SupabaseClient;
}

/**
 * Converts a "YYYY-MM-DD" and "HH:mm" time in a specific IANA timezone into a UTC Date.
 */
export function localTimeToUtc(
  dateStr: string,
  timeStr: string,
  timezone: string = "Asia/Kolkata",
): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hours, minutes] = timeStr.split(":").map(Number);

  // Guess UTC time
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

  // Determine timezone offset using Intl
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(utcGuess);
  const partMap: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      partMap[p.type] = parseInt(p.value, 10);
    }
  }

  const asLocal = Date.UTC(
    partMap.year,
    partMap.month - 1,
    partMap.day,
    partMap.hour === 24 ? 0 : partMap.hour,
    partMap.minute,
    partMap.second || 0,
  );

  const offsetMs = asLocal - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

/**
 * Format a Date to "HH:mm" in a target timezone.
 */
export function formatTimeInTimezone(date: Date, timezone: string = "Asia/Kolkata"): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(date);
}

/**
 * Get current date string "YYYY-MM-DD" in a target timezone.
 */
export function getTodayDateString(timezone: string = "Asia/Kolkata"): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

/**
 * Calculate day of week (0=Sunday, 1=Monday, ..., 6=Saturday) for "YYYY-MM-DD"
 */
export function getDayOfWeekForDate(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  // Noon UTC avoids any boundary issues
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return d.getUTCDay();
}

/**
 * Default fallback working hours when staff has no explicit availability records yet.
 * Mon-Fri (1-5), 09:00 to 17:00
 */
const DEFAULT_WORKING_HOURS = [
  { day_of_week: 1, start_time: "09:00:00", end_time: "17:00:00" },
  { day_of_week: 2, start_time: "09:00:00", end_time: "17:00:00" },
  { day_of_week: 3, start_time: "09:00:00", end_time: "17:00:00" },
  { day_of_week: 4, start_time: "09:00:00", end_time: "17:00:00" },
  { day_of_week: 5, start_time: "09:00:00", end_time: "17:00:00" },
];

/**
 * Core availability engine: returns actual bookable slots for a service and date.
 */
export async function getAvailableSlots({
  accountId,
  serviceId,
  staffId,
  date,
  timezone = "Asia/Kolkata",
  client,
}: GetAvailableSlotsParams): Promise<{
  date: string;
  timezone: string;
  service: AppointmentService | null;
  slots: TimeSlot[];
}> {
  const db = client ?? supabaseAdmin();

  // 1. Fetch Service
  const { data: service, error: serviceError } = await db
    .from("appointment_services")
    .select("*")
    .eq("id", serviceId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (serviceError || !service || !service.is_active) {
    return { date, timezone, service: null, slots: [] };
  }

  // 2. Fetch eligible staff
  let staffList: AppointmentStaff[] = [];

  if (staffId) {
    const { data: staff } = await db
      .from("appointment_staff")
      .select("*")
      .eq("id", staffId)
      .eq("account_id", accountId)
      .eq("is_active", true)
      .maybeSingle();

    if (staff) {
      staffList = [staff];
    }
  } else {
    // Check staff mapped to this service
    const { data: mappedStaffServices } = await db
      .from("appointment_staff_services")
      .select("staff_id")
      .eq("service_id", serviceId);

    const mappedStaffIds = (mappedStaffServices || []).map((m: { staff_id: string }) => m.staff_id);

    if (mappedStaffIds.length > 0) {
      const { data: staff } = await db
        .from("appointment_staff")
        .select("*")
        .eq("account_id", accountId)
        .eq("is_active", true)
        .in("id", mappedStaffIds);
      staffList = staff || [];
    } else {
      // If no explicit staff_services mappings exist, all active staff can perform the service
      const { data: staff } = await db
        .from("appointment_staff")
        .select("*")
        .eq("account_id", accountId)
        .eq("is_active", true);
      staffList = staff || [];
    }
  }

  if (staffList.length === 0) {
    return { date, timezone, service, slots: [] };
  }

  // 3. Check account-wide exceptions for this date (staff_id IS NULL)
  const { data: accountExceptions } = await db
    .from("appointment_availability_exceptions")
    .select("*")
    .eq("account_id", accountId)
    .is("staff_id", null)
    .eq("exception_date", date);

  if (accountExceptions && accountExceptions.some((e: AppointmentAvailabilityException) => e.is_unavailable)) {
    // Clinic is closed
    return { date, timezone, service, slots: [] };
  }

  // 4. Fetch staff exceptions for this date
  const staffIds = staffList.map((s) => s.id);
  const { data: staffExceptions } = await db
    .from("appointment_availability_exceptions")
    .select("*")
    .eq("account_id", accountId)
    .in("staff_id", staffIds)
    .eq("exception_date", date);

  const staffExceptionMap = new Map<string, AppointmentAvailabilityException[]>();
  for (const exc of staffExceptions || []) {
    if (exc.staff_id) {
      const existing = staffExceptionMap.get(exc.staff_id) || [];
      existing.push(exc);
      staffExceptionMap.set(exc.staff_id, existing);
    }
  }

  // 5. Fetch regular working hours for day of week
  const dayOfWeek = getDayOfWeekForDate(date);
  const { data: regularHours } = await db
    .from("appointment_availability")
    .select("*")
    .eq("account_id", accountId)
    .in("staff_id", staffIds)
    .eq("day_of_week", dayOfWeek);

  const hoursMap = new Map<string, AppointmentAvailability[]>();
  for (const h of regularHours || []) {
    const existing = hoursMap.get(h.staff_id) || [];
    existing.push(h);
    hoursMap.set(h.staff_id, existing);
  }

  // Check if staff has any availability configured at all
  const { data: anyAvailabilityStaff } = await db
    .from("appointment_availability")
    .select("staff_id")
    .eq("account_id", accountId)
    .in("staff_id", staffIds);

  const staffWithConfiguredHours = new Set(
    (anyAvailabilityStaff || []).map((h: { staff_id: string }) => h.staff_id),
  );

  // 6. Fetch existing appointments for these staff on this date
  // Window covers the full day in target timezone
  const dayStartUtc = localTimeToUtc(date, "00:00", timezone);
  const dayEndUtc = localTimeToUtc(date, "23:59:59", timezone);

  const { data: existingAppointments } = await db
    .from("appointments")
    .select("id, staff_id, start_at, end_at, status")
    .eq("account_id", accountId)
    .in("staff_id", staffIds)
    .in("status", ["pending", "confirmed"])
    .lt("start_at", dayEndUtc.toISOString())
    .gt("end_at", dayStartUtc.toISOString());

  const appointmentsByStaff = new Map<string, Array<{ start: number; end: number }>>();
  for (const app of existingAppointments || []) {
    const list = appointmentsByStaff.get(app.staff_id) || [];
    list.push({
      start: new Date(app.start_at).getTime(),
      end: new Date(app.end_at).getTime(),
    });
    appointmentsByStaff.set(app.staff_id, list);
  }

  // 7. Calculate slots per staff member
  const nowUtc = Date.now();
  // Minimum 15-minute lead time for same-day bookings
  const minBookingTime = nowUtc + 15 * 60 * 1000;

  const durationMs = service.duration_minutes * 60 * 1000;
  const bufferBeforeMs = service.buffer_before_minutes * 60 * 1000;
  const bufferAfterMs = service.buffer_after_minutes * 60 * 1000;

  // Grid step: 15 minutes or 30 minutes (minimum 15, maximum 30)
  const stepMs = (service.duration_minutes % 30 === 0 ? 30 : 15) * 60 * 1000;

  const candidateSlotsByTime = new Map<string, TimeSlot>();

  for (const staff of staffList) {
    const exceptions = staffExceptionMap.get(staff.id);

    // If staff has an exception marking them unavailable today, skip
    if (exceptions?.some((e) => e.is_unavailable)) {
      continue;
    }

    // Determine working intervals for today
    let intervals: Array<{ startStr: string; endStr: string }> = [];

    const modifiedException = exceptions?.find(
      (e) => !e.is_unavailable && e.start_time && e.end_time,
    );

    if (modifiedException?.start_time && modifiedException?.end_time) {
      intervals = [
        {
          startStr: modifiedException.start_time,
          endStr: modifiedException.end_time,
        },
      ];
    } else {
      const staffHours = hoursMap.get(staff.id);
      if (staffHours && staffHours.length > 0) {
        intervals = staffHours.map((h) => ({
          startStr: h.start_time,
          endStr: h.end_time,
        }));
      } else if (!staffWithConfiguredHours.has(staff.id)) {
        // Fallback default hours for staff who haven't set up custom schedule yet
        const defaultForDay = DEFAULT_WORKING_HOURS.find((h) => h.day_of_week === dayOfWeek);
        if (defaultForDay) {
          intervals = [{ startStr: defaultForDay.start_time, endStr: defaultForDay.end_time }];
        }
      }
    }

    if (intervals.length === 0) {
      continue;
    }

    const staffBookings = appointmentsByStaff.get(staff.id) || [];

    for (const interval of intervals) {
      const intervalStartUtc = localTimeToUtc(date, interval.startStr, timezone);
      const intervalEndUtc = localTimeToUtc(date, interval.endStr, timezone);

      let currentSlotStart = intervalStartUtc.getTime();

      while (currentSlotStart + durationMs <= intervalEndUtc.getTime()) {
        const slotEnd = currentSlotStart + durationMs;

        // Skip slots in the past
        if (currentSlotStart < minBookingTime) {
          currentSlotStart += stepMs;
          continue;
        }

        // Slot interval with buffers
        const blockedStart = currentSlotStart - bufferBeforeMs;
        const blockedEnd = slotEnd + bufferAfterMs;

        // Check conflicts with existing appointments
        const hasConflict = staffBookings.some((booking) => {
          return booking.start < blockedEnd && booking.end > blockedStart;
        });

        const slotTimeLabel = formatTimeInTimezone(new Date(currentSlotStart), timezone);
        const slotEndTimeLabel = formatTimeInTimezone(new Date(slotEnd), timezone);

        const slotObj: TimeSlot = {
          start: slotTimeLabel,
          end: slotEndTimeLabel,
          start_iso: new Date(currentSlotStart).toISOString(),
          end_iso: new Date(slotEnd).toISOString(),
          available: !hasConflict,
          staff_id: staff.id,
          staff_name: staff.name,
        };

        const existingSlot = candidateSlotsByTime.get(slotTimeLabel);

        if (!existingSlot) {
          candidateSlotsByTime.set(slotTimeLabel, slotObj);
        } else if (!existingSlot.available && slotObj.available) {
          // If previous staff was booked but this staff is free, mark available!
          candidateSlotsByTime.set(slotTimeLabel, slotObj);
        }

        currentSlotStart += stepMs;
      }
    }
  }

  // Sort slots chronologically
  const sortedSlots = Array.from(candidateSlotsByTime.values()).sort((a, b) =>
    a.start_iso.localeCompare(b.start_iso),
  );

  return {
    date,
    timezone,
    service,
    slots: sortedSlots,
  };
}

/**
 * Returns available dates in a window (e.g. next 14 days) indicating slot availability.
 */
export async function getAvailableDates({
  accountId,
  serviceId,
  staffId,
  startDate,
  daysCount = 14,
  timezone = "Asia/Kolkata",
  client,
}: GetAvailableDatesParams): Promise<AvailableDate[]> {
  const start = startDate || getTodayDateString(timezone);
  const [startYear, startMonth, startDay] = start.split("-").map(Number);

  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const results: AvailableDate[] = [];

  for (let i = 0; i < daysCount; i++) {
    const curDate = new Date(Date.UTC(startYear, startMonth - 1, startDay + i, 12, 0, 0));
    const dateStr = curDate.toISOString().slice(0, 10);
    const dayOfWeek = curDate.getUTCDay();

    const { slots } = await getAvailableSlots({
      accountId,
      serviceId,
      staffId,
      date: dateStr,
      timezone,
      client,
    });

    const availableSlots = slots.filter((s) => s.available);

    results.push({
      date: dateStr,
      day_name: dayNames[dayOfWeek],
      available: availableSlots.length > 0,
      slot_count: availableSlots.length,
    });
  }

  return results;
}
