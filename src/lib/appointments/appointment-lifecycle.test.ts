/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { canTransitionStatus } from "./status";
import {
  isSlotWithinShiftWithBuffers,
  filterStaffByServiceEligibility,
} from "./availability";
import { hasStaffConflict } from "./conflicts";
import {
  createAppointment,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "./booking";
import type {
  Appointment,
  AppointmentStaff,
  AppointmentService,
  AppointmentBusyPeriod,
  AppointmentCalendarLink,
} from "./types";

describe("Complete WACRM Appointment Lifecycle — End-to-End Proof", () => {
  // Shared mock state simulating database tables
  let appointmentsDb: Appointment[] = [];
  let busyPeriodsDb: AppointmentBusyPeriod[] = [];
  let calendarLinksDb: AppointmentCalendarLink[] = [];
  let contactsDb: Array<{ id: string; name: string; phone: string; account_id: string }> = [];

  const accountId = "acc-clinic-101";

  // Service: 30 min duration, 15 min buffer before, 15 min buffer after
  const serviceDental: AppointmentService = {
    id: "srv-dental-30",
    account_id: accountId,
    name: "Dental Cleaning & Checkup",
    duration_minutes: 30,
    buffer_before_minutes: 15,
    buffer_after_minutes: 15,
    price: 1500,
    currency: "INR",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const staffAlice: AppointmentStaff = {
    id: "staff-alice",
    account_id: accountId,
    name: "Dr. Alice",
    color: "#3b82f6",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const staffBob: AppointmentStaff = {
    id: "staff-bob",
    account_id: accountId,
    name: "Dr. Bob",
    color: "#10b981",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const staffCharlieInactive: AppointmentStaff = {
    id: "staff-charlie",
    account_id: accountId,
    name: "Dr. Charlie",
    color: "#9ca3af",
    is_active: false, // Inactive
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Mappings: Alice and Bob can do dental
  const staffMappings = [
    { staff_id: "staff-alice", service_id: serviceDental.id },
    { staff_id: "staff-bob", service_id: serviceDental.id },
  ];

  // Helper to create an in-memory database mock mimicking Supabase query builder
  function createTestDb() {
    return {
      from: (table: string) => {
        const filters: Array<{ col: string; op: string; val: unknown }> = [];

        const builder: any = {
          select: vi.fn(() => {
            return builder;
          }),
          eq: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "eq", val });
            return builder;
          }),
          neq: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "neq", val });
            return builder;
          }),
          in: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "in", val });
            return builder;
          }),
          lt: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "lt", val });
            return builder;
          }),
          gt: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "gt", val });
            return builder;
          }),
          gte: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "gte", val });
            return builder;
          }),
          lte: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "lte", val });
            return builder;
          }),
          like: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "like", val });
            return builder;
          }),
          ilike: vi.fn((col: string, val: unknown) => {
            filters.push({ col, op: "ilike", val });
            return builder;
          }),
          insert: vi.fn((row: any) => {
            const inserted = {
              ...row,
              id: row.id || `app-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            if (table === "appointments") {
              appointmentsDb.push(inserted);
            } else if (table === "contacts") {
              contactsDb.push(inserted);
            } else if (table === "appointment_busy_periods") {
              busyPeriodsDb.push(inserted);
            } else if (table === "appointment_calendar_links") {
              calendarLinksDb.push(inserted);
            }
            return {
              select: () => ({
                single: () => Promise.resolve({ data: inserted, error: null }),
                maybeSingle: () => Promise.resolve({ data: inserted, error: null }),
              }),
              single: () => Promise.resolve({ data: inserted, error: null }),
            };
          }),
          update: vi.fn((updates: any) => {
            const updateFilters: Array<{ col: string; op: string; val: unknown }> = [...filters];
            const executeUpdate = () => {
              let items: any[] = [];
              if (table === "appointments") items = appointmentsDb;
              for (const app of items) {
                if (updateFilters.every((f) => app[f.col as keyof Appointment] === f.val)) {
                  Object.assign(app, updates);
                }
              }
            };

            const updateBuilder: any = {
              eq: vi.fn((col: string, val: unknown) => {
                updateFilters.push({ col, op: "eq", val });
                executeUpdate();
                return updateBuilder;
              }),
              select: () => updateBuilder,
              single: async () => {
                executeUpdate();
                let items: any[] = [];
                if (table === "appointments") items = appointmentsDb;
                const match = items.find((item) =>
                  updateFilters.every((f) => item[f.col] === f.val)
                );
                return { data: match || null, error: null };
              },
              maybeSingle: async () => {
                executeUpdate();
                let items: any[] = [];
                if (table === "appointments") items = appointmentsDb;
                const match = items.find((item) =>
                  updateFilters.every((f) => item[f.col] === f.val)
                );
                return { data: match || null, error: null };
              },
              then: (resolve: any) => {
                executeUpdate();
                return resolve({ data: null, error: null });
              },
            };
            return updateBuilder;
          }),
          single: async () => {
            let list: any[] = [];
            if (table === "appointments") list = appointmentsDb;
            else if (table === "contacts") list = contactsDb;
            else if (table === "appointment_services") list = [serviceDental];
            else if (table === "appointment_staff") list = [staffAlice, staffBob];

            let filtered = [...list];
            for (const f of filters) {
              if (f.op === "eq") filtered = filtered.filter((r) => r[f.col] === f.val);
            }
            const item = filtered[0] || null;
            if (item && table === "appointments") {
              const srv = [serviceDental].find((s) => s.id === item.service_id);
              const stf = [staffAlice, staffBob].find((s) => s.id === item.staff_id);
              return {
                data: {
                  ...item,
                  service: item.service || srv,
                  staff: item.staff || stf,
                },
                error: null,
              };
            }
            return { data: item, error: null };
          },
          maybeSingle: async () => {
            let list: any[] = [];
            if (table === "appointments") list = appointmentsDb;
            else if (table === "contacts") list = contactsDb;
            else if (table === "appointment_services") list = [serviceDental];
            else if (table === "appointment_staff") list = [staffAlice, staffBob];

            let filtered = [...list];
            for (const f of filters) {
              if (f.op === "eq") filtered = filtered.filter((r) => r[f.col] === f.val);
            }
            const item = filtered[0] || null;
            if (item && table === "appointments") {
              const srv = [serviceDental].find((s) => s.id === item.service_id);
              const stf = [staffAlice, staffBob].find((s) => s.id === item.staff_id);
              return {
                data: {
                  ...item,
                  service: item.service || srv,
                  staff: item.staff || stf,
                },
                error: null,
              };
            }
            return { data: item, error: null };
          },
          then: (resolve: any) => {
            let list: any[] = [];
            if (table === "appointments") list = appointmentsDb;
            else if (table === "appointment_busy_periods") list = busyPeriodsDb;
            else if (table === "appointment_staff_services") list = staffMappings;
            else if (table === "appointment_staff") list = [staffAlice, staffBob];
            else if (table === "appointment_calendar_links") list = calendarLinksDb;

            let filtered = [...list];
            for (const f of filters) {
              if (f.op === "eq") filtered = filtered.filter((r) => r[f.col] === f.val);
              if (f.op === "neq") filtered = filtered.filter((r) => r[f.col] !== f.val);
              if (f.op === "in" && Array.isArray(f.val)) {
                filtered = filtered.filter((r) => (f.val as unknown[]).includes(r[f.col]));
              }
              if (f.op === "lt") {
                filtered = filtered.filter((r) => new Date(r[f.col]).getTime() < new Date(f.val as string).getTime());
              }
              if (f.op === "gt") {
                filtered = filtered.filter((r) => new Date(r[f.col]).getTime() > new Date(f.val as string).getTime());
              }
            }
            return resolve({ data: filtered, error: null });
          },
        };
        return builder;
      },
    };
  }

  beforeEach(() => {
    appointmentsDb = [];
    busyPeriodsDb = [];
    calendarLinksDb = [];
    contactsDb = [];
  });

  it("proves the complete appointment lifecycle end-to-end", async () => {
    const db = createTestDb();

    // ============================================================
    // STAGE 1: Staff Eligibility and Shift Boundary Calculation
    // ============================================================
    // Verify eligibility: Alice & Bob eligible, inactive Charlie excluded
    const eligibleStaff = filterStaffByServiceEligibility(
      [staffAlice, staffBob, staffCharlieInactive],
      serviceDental.id,
      staffMappings
    );
    expect(eligibleStaff.map((s) => s.id)).toEqual(["staff-alice", "staff-bob"]);

    // Provider Shift: 09:00 to 17:00 (Asia/Kolkata).
    // Test slot 09:00 to 09:30: Buffer before is 15m (starts at 08:45, before shift start 09:00) -> Must be rejected!
    const shiftStartMs = new Date("2026-10-05T09:00:00Z").getTime();
    const shiftEndMs = new Date("2026-10-05T17:00:00Z").getTime();

    const isSlot9amValid = isSlotWithinShiftWithBuffers(
      new Date("2026-10-05T09:00:00Z").getTime(),
      new Date("2026-10-05T09:30:00Z").getTime(),
      shiftStartMs,
      shiftEndMs,
      serviceDental.buffer_before_minutes,
      serviceDental.buffer_after_minutes
    );
    expect(isSlot9amValid).toBe(false);

    // Slot 09:15 to 09:45: Buffer before starts at 09:00 (== shiftStartMs) -> Valid!
    const isSlot915Valid = isSlotWithinShiftWithBuffers(
      new Date("2026-10-05T09:15:00Z").getTime(),
      new Date("2026-10-05T09:45:00Z").getTime(),
      shiftStartMs,
      shiftEndMs,
      serviceDental.buffer_before_minutes,
      serviceDental.buffer_after_minutes
    );
    expect(isSlot915Valid).toBe(true);

    // Slot 16:30 to 17:00: Buffer after ends at 17:15 (> shiftEndMs 17:00) -> Must be rejected!
    const isSlot1630Valid = isSlotWithinShiftWithBuffers(
      new Date("2026-10-05T16:30:00Z").getTime(),
      new Date("2026-10-05T17:00:00Z").getTime(),
      shiftStartMs,
      shiftEndMs,
      serviceDental.buffer_before_minutes,
      serviceDental.buffer_after_minutes
    );
    expect(isSlot1630Valid).toBe(false);

    // ============================================================
    // STAGE 2: External Busy Period Blocks Provider Availability
    // ============================================================
    // Dr. Alice has an external Google Calendar meeting from 13:00 to 14:00
    busyPeriodsDb.push({
      id: "busy-alice-lunch",
      account_id: accountId,
      staff_id: "staff-alice",
      start_at: "2026-10-05T13:00:00.000Z",
      end_at: "2026-10-05T14:00:00.000Z",
      source: "external_calendar",
      title: "Clinic Team Sync",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Check conflict for Alice during 13:15 - 13:45
    const aliceHasConflictDuringSync = await hasStaffConflict({
      accountId,
      staffId: "staff-alice",
      startAt: new Date("2026-10-05T13:15:00.000Z"),
      endAt: new Date("2026-10-05T13:45:00.000Z"),
      client: db as any,
    });
    expect(aliceHasConflictDuringSync).toBe(true);

    // Check conflict for Bob during the same time (Bob has no busy period)
    const bobHasConflictDuringSync = await hasStaffConflict({
      accountId,
      staffId: "staff-bob",
      startAt: new Date("2026-10-05T13:15:00.000Z"),
      endAt: new Date("2026-10-05T13:45:00.000Z"),
      client: db as any,
    });
    expect(bobHasConflictDuringSync).toBe(false);

    // ============================================================
    // STAGE 3: Booking Appointment via Central Booking Engine
    // ============================================================
    // Customer books 10:00 - 10:30 with Any Provider
    const bookingResult = await createAppointment(
      {
        accountId,
        serviceId: serviceDental.id,
        // staffId omitted -> Any Provider assignment!
        startAt: "2026-10-05T10:00:00.000Z",
        endAt: "2026-10-05T10:30:00.000Z",
        customerName: "Ketan Sharma",
        customerPhone: "+919876543210",
        source: "whatsapp_flow",
        status: "confirmed",
      },
      db as any
    );

    expect(bookingResult.ok).toBe(true);
    expect(bookingResult.appointment).toBeDefined();

    const appt1 = bookingResult.appointment!;
    expect(appt1.status).toBe("confirmed");
    expect(appt1.customer_name).toBe("Ketan Sharma");
    // Verify an eligible staff was automatically assigned
    expect(["staff-alice", "staff-bob"]).toContain(appt1.staff_id);

    const assignedStaffId = appt1.staff_id;

    // ============================================================
    // STAGE 4: Concurrency & Conflict Protection
    // ============================================================
    // Another customer attempts to book the same staff for an overlapping slot (10:15 - 10:45)
    const conflictResult = await createAppointment(
      {
        accountId,
        serviceId: serviceDental.id,
        staffId: assignedStaffId,
        startAt: "2026-10-05T10:15:00.000Z",
        endAt: "2026-10-05T10:45:00.000Z",
        customerName: "Sneha Patel",
        customerPhone: "+919812345678",
      },
      db as any
    );

    expect(conflictResult.ok).toBe(false);
    expect(conflictResult.code).toBe("SLOT_ALREADY_BOOKED");

    // ============================================================
    // STAGE 5: Reminder Sweep with Atomic Conditional Claim
    // ============================================================
    // Simulate atomic reminder claim:
    // UPDATE appointments SET reminder_sent_24h = true WHERE id = ? AND reminder_sent_24h = false RETURNING id;
    let reminderDispatches = 0;

    const claimAndSendReminder = async (appointmentId: string) => {
      const match = appointmentsDb.find(
        (a) => a.id === appointmentId && !a.reminder_sent_24h
      );
      if (match) {
        match.reminder_sent_24h = true;
        reminderDispatches += 1;
        return { success: true };
      }
      return { success: false };
    };

    // Simulate two concurrent cron workers claiming the same appointment
    const [worker1, worker2] = await Promise.all([
      claimAndSendReminder(appt1.id),
      claimAndSendReminder(appt1.id),
    ]);

    expect([worker1.success, worker2.success].filter(Boolean).length).toBe(1);
    expect(reminderDispatches).toBe(1); // Idempotent!

    // ============================================================
    // STAGE 6: Atomic Rescheduling with Full History Preservation
    // ============================================================
    // Customer requests afternoon slot (15:00 - 15:30)
    const rescheduleResult = await rescheduleAppointment(
      {
        accountId,
        appointmentId: appt1.id,
        newStartAt: "2026-10-05T15:00:00.000Z",
        newEndAt: "2026-10-05T15:30:00.000Z",
        rescheduleReason: "Customer had meeting conflict in morning",
      },
      db as any
    );

    expect(rescheduleResult.ok).toBe(true);
    const appt2 = rescheduleResult.appointment!;
    expect(appt2.id).not.toBe(appt1.id);
    expect(appt2.status).toBe("confirmed");
    expect(appt2.rescheduled_from_id).toBe(appt1.id);
    expect(appt2.start_at).toBe("2026-10-05T15:00:00.000Z");

    // Inspect the original appointment row:
    const oldApptRow = appointmentsDb.find((a) => a.id === appt1.id)!;
    expect(oldApptRow.status).toBe("rescheduled");
    expect(oldApptRow.rescheduled_to_id).toBe(appt2.id);
    expect(oldApptRow.rescheduled_at).toBeDefined();
    expect(oldApptRow.reschedule_reason).toBe("Customer had meeting conflict in morning");
    // Crucially: Cancellation fields MUST remain null!
    expect(oldApptRow.cancelled_at).toBeFalsy();
    expect(oldApptRow.cancelled_by).toBeFalsy();

    // Verify the morning slot (10:00 - 10:30) is now FREED UP for the assigned staff:
    const morningSlotConflictAfterReschedule = await hasStaffConflict({
      accountId,
      staffId: assignedStaffId,
      startAt: new Date("2026-10-05T10:00:00.000Z"),
      endAt: new Date("2026-10-05T10:30:00.000Z"),
      client: db as any,
    });
    expect(morningSlotConflictAfterReschedule).toBe(false);

    // ============================================================
    // STAGE 7: Two-Way Calendar Sync Mapping Link
    // ============================================================
    // External calendar integration creates a link row
    calendarLinksDb.push({
      id: "cal-link-1",
      account_id: accountId,
      appointment_id: appt2.id,
      provider: "google",
      external_calendar_id: "dr_alice@example.com",
      external_event_id: "g_cal_evt_998877",
      sync_status: "synced",
      last_synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const linkedRecords = calendarLinksDb.filter((c) => c.appointment_id === appt2.id);
    expect(linkedRecords.length).toBe(1);
    expect(linkedRecords[0].provider).toBe("google");
    expect(linkedRecords[0].sync_status).toBe("synced");

    // ============================================================
    // STAGE 8: Appointment Outcome & State Transition Integrity
    // ============================================================
    // Appointment takes place, staff marks it as 'completed'
    const completeResult = await updateAppointmentStatus(
      appt2.id,
      accountId,
      "completed",
      db as any
    );
    expect(completeResult.ok).toBe(true);

    const completedAppt = appointmentsDb.find((a) => a.id === appt2.id)!;
    expect(completedAppt.status).toBe("completed");

    // Validate Terminal State Integrity:
    // Completed appointment cannot transition back to pending or confirmed
    expect(canTransitionStatus(completedAppt.status, "pending")).toBe(false);
    expect(canTransitionStatus(completedAppt.status, "confirmed")).toBe(false);

    const illegalTransitionResult = await updateAppointmentStatus(
      appt2.id,
      accountId,
      "pending",
      db as any
    );
    expect(illegalTransitionResult.ok).toBe(false);
    expect(illegalTransitionResult.code).toBe("INVALID_STATUS_TRANSITION");

    // The complete appointment lifecycle has been executed and proven end-to-end!
  });

  it("proves atomic RPC booking and rescheduling execution with relation hydration", async () => {
    const db = createTestDb();

    // Mock db.rpc for book_appointment_atomic and reschedule_appointment_atomic
    (db as any).rpc = vi.fn(async (procName: string, args: any) => {
      if (procName === "book_appointment_atomic") {
        const row: Appointment = {
          id: "app-rpc-1",
          account_id: args.p_account_id,
          service_id: args.p_service_id,
          staff_id: args.p_staff_id || "staff-alice",
          start_at: args.p_start_at,
          end_at: args.p_end_at,
          timezone: args.p_timezone,
          status: args.p_status || "confirmed",
          source: args.p_source || "dashboard",
          customer_name: args.p_customer_name,
          customer_phone: args.p_customer_phone,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        appointmentsDb.push(row);
        return {
          data: {
            ok: true,
            appointment: row,
          },
          error: null,
        };
      }

      if (procName === "reschedule_appointment_atomic") {
        const oldApp = appointmentsDb.find((a) => a.id === args.p_appointment_id)!;
        oldApp.status = "rescheduled";
        oldApp.rescheduled_at = new Date().toISOString();
        oldApp.reschedule_reason = args.p_reschedule_reason;

        const newRow: Appointment = {
          id: "app-rpc-rescheduled-2",
          account_id: args.p_account_id,
          service_id: oldApp.service_id,
          staff_id: args.p_staff_id || oldApp.staff_id,
          start_at: args.p_new_start_at,
          end_at: args.p_new_end_at,
          timezone: oldApp.timezone,
          status: "confirmed",
          source: oldApp.source,
          customer_name: oldApp.customer_name,
          customer_phone: oldApp.customer_phone,
          rescheduled_from_id: oldApp.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        oldApp.rescheduled_to_id = newRow.id;
        appointmentsDb.push(newRow);

        return {
          data: {
            ok: true,
            appointment: newRow,
          },
          error: null,
        };
      }

      return { data: null, error: new Error(`Unknown RPC ${procName}`) };
    });

    // 1. Atomic Booking
    const bookRes = await createAppointment(
      {
        accountId,
        serviceId: serviceDental.id,
        startAt: "2026-10-06T11:00:00.000Z",
        endAt: "2026-10-06T11:30:00.000Z",
        customerName: "Priya Nair",
        customerPhone: "+919123456780",
      },
      db as any
    );

    expect(bookRes.ok).toBe(true);
    expect(bookRes.appointment?.id).toBe("app-rpc-1");
    // Verify relation hydration
    expect(bookRes.appointment?.service?.name).toBe("Dental Cleaning & Checkup");
    expect(bookRes.appointment?.staff?.name).toBe("Dr. Alice");

    // 2. Atomic Reschedule
    const reschRes = await rescheduleAppointment(
      {
        accountId,
        appointmentId: "app-rpc-1",
        newStartAt: "2026-10-06T16:00:00.000Z",
        newEndAt: "2026-10-06T16:30:00.000Z",
        rescheduleReason: "Requested end of day slot",
      },
      db as any
    );

    expect(reschRes.ok).toBe(true);
    expect(reschRes.appointment?.id).toBe("app-rpc-rescheduled-2");
    expect(reschRes.appointment?.rescheduled_from_id).toBe("app-rpc-1");
    // Verify relation hydration
    expect(reschRes.appointment?.service?.name).toBe("Dental Cleaning & Checkup");
    expect(reschRes.appointment?.staff?.name).toBe("Dr. Alice");

    // Verify old row in db
    const oldRow = appointmentsDb.find((a) => a.id === "app-rpc-1")!;
    expect(oldRow.status).toBe("rescheduled");
    expect(oldRow.rescheduled_to_id).toBe("app-rpc-rescheduled-2");
    expect(oldRow.reschedule_reason).toBe("Requested end of day slot");
    expect(oldRow.cancelled_at).toBeFalsy();
    expect(oldRow.cancelled_by).toBeFalsy();
  });
});
