import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    appointments: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ table: string; id: string; values: Record<string, unknown> }>,
    waConfig: null as Record<string, unknown> | null,
  },
  runAutomations: vi.fn(),
  sendTextMessage: vi.fn(),
  decrypt: vi.fn((token: string) => `decrypted_${token}`),
}));

vi.mock("./admin-client", () => {
  function queryBuilder(table: string) {
    let selectedCols = "*";
    const filters: Array<{ col: string; op: string; val: unknown }> = [];

    const builder: Record<string, unknown> = {
      select: vi.fn((cols: string) => {
        selectedCols = cols;
        return builder;
      }),
      eq: vi.fn((col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return builder;
      }),
      gt: vi.fn((col: string, val: unknown) => {
        filters.push({ col, op: "gt", val });
        return builder;
      }),
      lte: vi.fn((col: string, val: unknown) => {
        filters.push({ col, op: "lte", val });
        return builder;
      }),
      update: vi.fn((values: Record<string, unknown>) => {
        return {
          eq: vi.fn((col: string, idVal: string) => {
            h.state.updates.push({ table, id: idVal, values });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }),
      maybeSingle: vi.fn(async () => {
        if (table === "whatsapp_config") {
          return { data: h.state.waConfig, error: null };
        }
        return { data: null, error: null };
      }),
      then: (resolve: (val: unknown) => unknown) => {
        if (table === "appointments") {
          // Filter matching appointments
          let matched = [...h.state.appointments];
          for (const f of filters) {
            if (f.op === "eq") {
              matched = matched.filter((row) => row[f.col] === f.val);
            }
          }
          return resolve({ data: matched, error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return builder;
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => queryBuilder(table),
    }),
  };
});

vi.mock("@/lib/automations/engine", () => ({
  runAutomationsForTrigger: h.runAutomations,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: h.sendTextMessage,
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: h.decrypt,
}));

import { processAppointmentReminders } from "./reminders";

describe("processAppointmentReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.state.appointments = [];
    h.state.updates = [];
    h.state.waConfig = {
      phone_number_id: "phone_123",
      access_token: "enc_token_xyz",
    };
  });

  it("processes 24h reminders and dispatches WhatsApp notification and automation", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    h.state.appointments = [
      {
        id: "apt_1",
        account_id: "acc_1",
        contact_id: "con_1",
        customer_name: "Alice",
        customer_phone: "+1234567890",
        service_id: "svc_1",
        staff_id: "staff_1",
        status: "confirmed",
        reminder_sent_24h: false,
        reminder_sent_2h: false,
        start_at: futureDate,
        end_at: futureDate,
        timezone: "Asia/Kolkata",
        service: { name: "Dental Checkup" },
        staff: { name: "Dr. Bob" },
      },
    ];

    const result = await processAppointmentReminders("acc_1");

    expect(result.processed24h).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify database update
    expect(h.state.updates).toContainEqual({
      table: "appointments",
      id: "apt_1",
      values: { reminder_sent_24h: true },
    });

    // Verify automation dispatch
    expect(h.runAutomations).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        triggerType: "appointment_reminder",
        contactId: "con_1",
        context: expect.objectContaining({
          vars: expect.objectContaining({
            reminder_type: "24h",
            appointment_id: "apt_1",
            appointment_service: "Dental Checkup",
            appointment_staff: "Dr. Bob",
          }),
        }),
      }),
    );

    // Verify direct WhatsApp message
    expect(h.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "phone_123",
        accessToken: "decrypted_enc_token_xyz",
        to: "+1234567890",
        text: expect.stringContaining("Reminder: You have an upcoming Dental Checkup with Dr. Bob tomorrow"),
      }),
    );
  });

  it("processes 2h reminders and sends 2h template text", async () => {
    const nearDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    h.state.appointments = [
      {
        id: "apt_2",
        account_id: "acc_1",
        contact_id: "con_2",
        customer_name: "Charlie",
        customer_phone: "+9876543210",
        service_id: "svc_1",
        staff_id: "staff_1",
        status: "confirmed",
        reminder_sent_24h: true, // 24h already sent
        reminder_sent_2h: false,
        start_at: nearDate,
        end_at: nearDate,
        timezone: "Asia/Kolkata",
        service: { name: "Haircut" },
        staff: { name: "Sam" },
      },
    ];

    const result = await processAppointmentReminders("acc_1");

    expect(result.processed2h).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify database update
    expect(h.state.updates).toContainEqual({
      table: "appointments",
      id: "apt_2",
      values: { reminder_sent_2h: true },
    });

    // Verify 2h text format
    expect(h.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+9876543210",
        text: expect.stringContaining("Your Haircut with Sam is today at"),
      }),
    );
  });

  it("handles appointments with no phone gracefully", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    h.state.appointments = [
      {
        id: "apt_3",
        account_id: "acc_1",
        contact_id: "con_3",
        customer_name: "David",
        customer_phone: "",
        service_id: "svc_1",
        status: "confirmed",
        reminder_sent_24h: false,
        reminder_sent_2h: false,
        start_at: futureDate,
        end_at: futureDate,
        timezone: "Asia/Kolkata",
      },
    ];

    const result = await processAppointmentReminders();
    expect(result.processed24h).toBe(1);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.runAutomations).toHaveBeenCalled();
  });
});
