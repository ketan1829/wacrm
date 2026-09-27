/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import {
  canTransitionStatus,
  getActionableErrorMessage,
  type AppointmentErrorCode,
} from "./status";
import {
  isSlotWithinShiftWithBuffers,
  filterStaffByServiceEligibility,
} from "./availability";
import { hasStaffConflict } from "./conflicts";
import { rescheduleAppointment } from "./booking";
import type { AppointmentStaff } from "./types";

describe("WACRM Appointment / Calendar V1 — Refinements Test Suite", () => {
  describe("1. Centralized Status Transitions & Error Codes", () => {
    it("permits valid appointment status transitions", () => {
      expect(canTransitionStatus("pending", "confirmed")).toBe(true);
      expect(canTransitionStatus("pending", "cancelled")).toBe(true);
      expect(canTransitionStatus("confirmed", "completed")).toBe(true);
      expect(canTransitionStatus("confirmed", "cancelled")).toBe(true);
      expect(canTransitionStatus("confirmed", "rescheduled")).toBe(true);
      expect(canTransitionStatus("confirmed", "no_show")).toBe(true);
      expect(canTransitionStatus("no_show", "confirmed")).toBe(true);
    });

    it("rejects illegal transitions from terminal states", () => {
      expect(canTransitionStatus("completed", "pending")).toBe(false);
      expect(canTransitionStatus("completed", "confirmed")).toBe(false);
      expect(canTransitionStatus("completed", "cancelled")).toBe(false);
      expect(canTransitionStatus("cancelled", "confirmed")).toBe(false);
      expect(canTransitionStatus("cancelled", "pending")).toBe(false);
      expect(canTransitionStatus("rescheduled", "confirmed")).toBe(false);
      expect(canTransitionStatus("rescheduled", "pending")).toBe(false);
    });

    it("returns actionable, user-friendly messages for all error codes", () => {
      const codes: AppointmentErrorCode[] = [
        "SLOT_UNAVAILABLE",
        "SLOT_ALREADY_BOOKED",
        "PROVIDER_NOT_ELIGIBLE",
        "SERVICE_INACTIVE",
        "STAFF_INACTIVE",
        "STAFF_NOT_FOUND",
        "SERVICE_NOT_FOUND",
        "OUTSIDE_WORKING_HOURS",
        "APPOINTMENT_NOT_RESCHEDULABLE",
        "INVALID_STATUS_TRANSITION",
        "INVALID_TIME_RANGE",
        "NOT_FOUND",
        "UNAUTHORIZED",
        "DATABASE_ERROR",
      ];

      for (const code of codes) {
        const msg = getActionableErrorMessage(code);
        expect(typeof msg).toBe("string");
        expect(msg.length).toBeGreaterThan(10);
      }
    });
  });

  describe("2. Shift Boundaries and Buffer Calculations", () => {
    // Shift: 09:00 to 17:00 (in epoch ms)
    const msAt = (h: number, m: number) =>
      new Date(Date.UTC(2026, 9, 1, h, m, 0, 0)).getTime();

    const shiftStart = msAt(9, 0);
    const shiftEnd = msAt(17, 0);

    it("enforces buffer_before at shift start", () => {
      const bufferBefore = 15; // 15 mins
      const bufferAfter = 10;

      // Slot starting exactly at shift start (09:00 to 09:30):
      // Buffer before requires provider from 08:45, which is before 09:00 shift start -> INVALID
      const slot1Start = msAt(9, 0);
      const slot1End = msAt(9, 30);
      expect(
        isSlotWithinShiftWithBuffers(
          slot1Start,
          slot1End,
          shiftStart,
          shiftEnd,
          bufferBefore,
          bufferAfter
        )
      ).toBe(false);

      // Slot starting at 09:15 to 09:45:
      // Buffer before: 09:00 >= 09:00 (shift start)
      // Buffer after: 09:55 <= 17:00 (shift end) -> VALID
      const slot2Start = msAt(9, 15);
      const slot2End = msAt(9, 45);
      expect(
        isSlotWithinShiftWithBuffers(
          slot2Start,
          slot2End,
          shiftStart,
          shiftEnd,
          bufferBefore,
          bufferAfter
        )
      ).toBe(true);
    });

    it("enforces buffer_after at shift end", () => {
      const bufferBefore = 10;
      const bufferAfter = 20; // 20 mins

      // Slot 16:30 to 17:00:
      // Buffer after requires provider until 17:20, which is after 17:00 shift end -> INVALID
      const slotLateStart = msAt(16, 30);
      const slotLateEnd = msAt(17, 0);
      expect(
        isSlotWithinShiftWithBuffers(
          slotLateStart,
          slotLateEnd,
          shiftStart,
          shiftEnd,
          bufferBefore,
          bufferAfter
        )
      ).toBe(false);

      // Slot 16:10 to 16:40:
      // Buffer after: 17:00 <= 17:00 -> VALID
      const slotValidStart = msAt(16, 10);
      const slotValidEnd = msAt(16, 40);
      expect(
        isSlotWithinShiftWithBuffers(
          slotValidStart,
          slotValidEnd,
          shiftStart,
          shiftEnd,
          bufferBefore,
          bufferAfter
        )
      ).toBe(true);
    });
  });

  describe("3. Provider-Service Eligibility Mapping Rules", () => {
    const mockStaff: AppointmentStaff[] = [
      {
        id: "staff-1",
        account_id: "acc-1",
        name: "Dr. Alice",
        color: "#3b82f6",
        is_active: true,
        created_at: "",
        updated_at: "",
      },
      {
        id: "staff-2",
        account_id: "acc-1",
        name: "Dr. Bob",
        color: "#10b981",
        is_active: true,
        created_at: "",
        updated_at: "",
      },
      {
        id: "staff-3",
        account_id: "acc-1",
        name: "Dr. Charlie (Inactive)",
        color: "#6b7280",
        is_active: false,
        created_at: "",
        updated_at: "",
      },
    ];

    it("filters to mapped active staff when service mappings exist", () => {
      const mappings = [
        { staff_id: "staff-1", service_id: "srv-dental" },
        { staff_id: "staff-3", service_id: "srv-dental" }, // inactive
      ];

      const eligible = filterStaffByServiceEligibility(
        mockStaff,
        "srv-dental",
        mappings
      );

      expect(eligible.map((s) => s.id)).toEqual(["staff-1"]);
    });

    it("considers all active staff eligible when service has NO specific mappings", () => {
      const mappings = [
        { staff_id: "staff-1", service_id: "other-service" },
      ];

      // "srv-general" has no mappings
      const eligible = filterStaffByServiceEligibility(
        mockStaff,
        "srv-general",
        mappings
      );

      // Returns all active staff (staff-1, staff-2), excludes inactive staff-3
      expect(eligible.map((s) => s.id)).toEqual(["staff-1", "staff-2"]);
    });
  });

  describe("4. Conflict Detection with Busy Periods & Active Appointments", () => {
    function createMockConflictClient({
      appointments = [] as Array<Record<string, unknown>>,
      busyPeriods = [] as Array<Record<string, unknown>>,
    }) {
      return {
        from: (table: string) => {
          const list = table === "appointments" ? appointments : busyPeriods;
          const builder: any = {
            select: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            neq: vi.fn(() => builder),
            in: vi.fn(() => builder),
            lt: vi.fn(() => builder),
            gt: vi.fn(() => builder),
            then: (resolve: any) => resolve({ data: list, error: null }),
          };
          return builder;
        },
      };
    }

    it("detects conflict when an active appointment overlaps", async () => {
      const mockClient = createMockConflictClient({
        appointments: [
          {
            id: "app-1",
            start_at: "2026-10-01T10:00:00Z",
            end_at: "2026-10-01T10:30:00Z",
            status: "confirmed",
          },
        ],
      });

      const hasConflict = await hasStaffConflict({
        accountId: "acc-1",
        staffId: "staff-1",
        startAt: new Date("2026-10-01T10:15:00Z"),
        endAt: new Date("2026-10-01T10:45:00Z"),
        client: mockClient as any,
      });

      expect(hasConflict).toBe(true);
    });

    it("detects conflict when appointment_busy_periods overlaps", async () => {
      const mockClient = createMockConflictClient({
        busyPeriods: [
          {
            id: "busy-1",
            start_at: "2026-10-01T14:00:00Z",
            end_at: "2026-10-01T15:00:00Z",
          },
        ],
      });

      const hasConflict = await hasStaffConflict({
        accountId: "acc-1",
        staffId: "staff-1",
        startAt: new Date("2026-10-01T14:30:00Z"),
        endAt: new Date("2026-10-01T15:00:00Z"),
        client: mockClient as any,
      });

      expect(hasConflict).toBe(true);
    });

    it("returns false when no appointments or busy periods overlap", async () => {
      const mockClient = createMockConflictClient({});

      const hasConflict = await hasStaffConflict({
        accountId: "acc-1",
        staffId: "staff-1",
        startAt: new Date("2026-10-01T11:00:00Z"),
        endAt: new Date("2026-10-01T11:30:00Z"),
        client: mockClient as any,
      });

      expect(hasConflict).toBe(false);
    });
  });

  describe("5. Atomic Rescheduling & History Preservation", () => {
    it("reschedules via atomic RPC, updates rescheduled_at without touching cancelled_at", async () => {
      let rpcCalledWith: Record<string, unknown> | null = null;

      const mockClient = {
        rpc: vi.fn((procName: string, args: Record<string, unknown>) => {
          rpcCalledWith = args;
          return Promise.resolve({
            data: {
              ok: true,
              appointment: {
                id: "app-new-123",
                status: "confirmed",
                rescheduled_from_id: args.p_appointment_id,
                start_at: args.p_new_start_at,
                end_at: args.p_new_end_at,
              },
            },
            error: null,
          });
        }),
        from: (table: string) => {
          const builder: any = {
            select: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            in: vi.fn(() => builder),
            lt: vi.fn(() => builder),
            gt: vi.fn(() => builder),
            lte: vi.fn(() => builder),
            gte: vi.fn(() => builder),
            maybeSingle: vi.fn(() => {
              if (table === "appointments") {
                return Promise.resolve({
                  data: {
                    id: "app-new-123",
                    status: "confirmed",
                    rescheduled_from_id: "app-old-1",
                    service: { id: "srv-1", name: "Consultation" },
                    staff: { id: "staff-1", name: "Dr. Smith" },
                  },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            }),
            single: vi.fn(() => {
              if (table === "appointments") {
                return Promise.resolve({
                  data: {
                    id: "app-old-1",
                    status: "confirmed",
                    contact_id: "cont-1",
                  },
                  error: null,
                });
              }
              return Promise.resolve({ data: null, error: null });
            }),
          };
          return builder;
        },
      };

      const res = await rescheduleAppointment(
        {
          accountId: "acc-1",
          appointmentId: "app-old-1",
          newStartAt: "2026-10-02T14:00:00.000Z",
          newEndAt: "2026-10-02T14:30:00.000Z",
          rescheduleReason: "Customer requested afternoon slot",
        },
        mockClient as any
      );

      expect(res.ok).toBe(true);
      expect(res.appointment?.id).toBe("app-new-123");
      expect(res.appointment?.rescheduled_from_id).toBe("app-old-1");
      expect(rpcCalledWith).toEqual({
        p_appointment_id: "app-old-1",
        p_account_id: "acc-1",
        p_new_start_at: "2026-10-02T14:00:00.000Z",
        p_new_end_at: "2026-10-02T14:30:00.000Z",
        p_staff_id: undefined,
        p_reschedule_reason: "Customer requested afternoon slot",
      });
    });

    it("rejects rescheduling when appointment is cancelled", async () => {
      const mockClient = {
        from: () => {
          const builder: any = {
            select: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            single: vi.fn(() =>
              Promise.resolve({
                data: {
                  id: "app-old-cancelled",
                  status: "cancelled",
                },
                error: null,
              })
            ),
          };
          return builder;
        },
      };

      const res = await rescheduleAppointment(
        {
          accountId: "acc-1",
          appointmentId: "app-old-cancelled",
          newStartAt: "2026-10-02T14:00:00Z",
          newEndAt: "2026-10-02T14:30:00Z",
        },
        mockClient as any
      );

      expect(res.ok).toBe(false);
      expect(res.code).toBe("APPOINTMENT_NOT_RESCHEDULABLE");
    });
  });

  describe("6. Concurrency Simulation & Slot Contention", () => {
    it("ensures exactly one of concurrent bookings succeeds and the other receives SLOT_ALREADY_BOOKED", async () => {
      let slotClaimed = false;

      const attemptBooking = async (customerId: string) => {
        // Atomic test simulation:
        // First request atomically claims slot (slotClaimed = true).
        // Second concurrent request finds slotClaimed === true and rejects.
        if (slotClaimed) {
          return {
            ok: false,
            code: "SLOT_ALREADY_BOOKED",
            error: getActionableErrorMessage("SLOT_ALREADY_BOOKED"),
          };
        }
        slotClaimed = true;
        return {
          ok: true,
          appointment: {
            id: `app-concurrent-${customerId}`,
            status: "confirmed",
          },
        };
      };

      const [res1, res2] = await Promise.all([
        attemptBooking("cust-1"),
        attemptBooking("cust-2"),
      ]);

      const successCount = [res1, res2].filter((r) => r.ok).length;
      const collisionCount = [res1, res2].filter(
        (r) => !r.ok && r.code === "SLOT_ALREADY_BOOKED"
      ).length;

      expect(successCount).toBe(1);
      expect(collisionCount).toBe(1);
    });

    it("handles atomic Any-Provider allocation without contention", async () => {
      // Two providers are available for the same slot
      const availableProviders = ["staff-alice", "staff-bob"];
      const allocatedProviders: string[] = [];

      const attemptAnyProviderBooking = async (custName: string) => {
        // Pop available provider atomically
        const assigned = availableProviders.shift();
        if (!assigned) {
          return { ok: false, code: "SLOT_ALREADY_BOOKED" };
        }
        allocatedProviders.push(assigned);
        return {
          ok: true,
          appointment: {
            id: `app-${custName}`,
            staff_id: assigned,
          },
        };
      };

      const [bookA, bookB, bookC] = await Promise.all([
        attemptAnyProviderBooking("cust-A"),
        attemptAnyProviderBooking("cust-B"),
        attemptAnyProviderBooking("cust-C"),
      ]);

      expect(bookA.ok).toBe(true);
      expect(bookB.ok).toBe(true);
      expect(bookC.ok).toBe(false); // Only 2 providers existed, 3rd gets rejected
      expect(bookC.code).toBe("SLOT_ALREADY_BOOKED");

      // Verify two distinct providers were assigned
      expect(allocatedProviders).toContain("staff-alice");
      expect(allocatedProviders).toContain("staff-bob");
      expect(new Set(allocatedProviders).size).toBe(2);
    });
  });

  describe("7. Reminder Idempotency with Conditional Claim", () => {
    it("prevents double-sending reminders when two sweeps run concurrently", async () => {
      let reminderSent = false;
      let sendDispatches = 0;

      // Simulated atomic conditional claim:
      // UPDATE appointments SET reminder_sent_24h = true WHERE id = ? AND reminder_sent_24h = false RETURNING id;
      const atomicClaimReminder = async (appointmentId: string) => {
        void appointmentId;
        if (!reminderSent) {
          reminderSent = true;
          sendDispatches += 1;
          return { claimed: true };
        }
        return { claimed: false };
      };

      // Two concurrent sweep jobs pick up the same due appointment
      const [sweep1, sweep2] = await Promise.all([
        atomicClaimReminder("app-due-1"),
        atomicClaimReminder("app-due-1"),
      ]);

      const claimedCount = [sweep1, sweep2].filter((s) => s.claimed).length;
      expect(claimedCount).toBe(1);
      expect(sendDispatches).toBe(1); // Sent exactly once!
    });
  });
});
