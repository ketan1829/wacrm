import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    activeRuns: [] as Record<string, unknown>[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    messages: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    updates: [] as { table: string; row: Record<string, unknown> }[],
    services: [] as Record<string, unknown>[],
    staff: [] as Record<string, unknown>[],
    contacts: [] as Record<string, unknown>[],
  },
  sendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendList: vi.fn(async () => ({ whatsapp_message_id: "wamid.list" })),
  getAvailableDatesMock: vi.fn(),
  getAvailableSlotsMock: vi.fn(),
  createAppointmentMock: vi.fn(),
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "messages") return h.state.messages;
    if (table === "appointment_services") return h.state.services;
    if (table === "appointment_staff") return h.state.staff;
    if (table === "contacts") return h.state.contacts;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        return b;
      },
      is: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (row: Record<string, unknown>) => {
        h.state.updates.push({ table, row });
        if (table === "flow_runs" && h.state.activeRuns[0]) {
          Object.assign(h.state.activeRuns[0], row);
        }
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "flow_run_events") {
          h.state.events.push(row);
        }
        return Promise.resolve({ error: null });
      },
      maybeSingle: async () => ({
        data: rows(table)[0] ?? null,
        error: null,
      }),
      single: async () => ({
        data: rows(table)[0] ?? null,
        error: null,
      }),
      then: (
        resolve: (r: {
          data: unknown[];
          error: null;
          count: number;
        }) => unknown,
      ) => resolve({ data: rows(table), error: null, count: rows(table).length }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: (...args: unknown[]) =>
    (h.sendText as unknown as (...x: unknown[]) => unknown)(...args),
  engineSendInteractiveList: (...args: unknown[]) =>
    (h.sendList as unknown as (...x: unknown[]) => unknown)(...args),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.btn" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.media" })),
}));

vi.mock("@/lib/appointments/availability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appointments/availability")>();
  return {
    ...actual,
    getAvailableDates: (...args: unknown[]) =>
      (h.getAvailableDatesMock as unknown as (...x: unknown[]) => unknown)(...args),
    getAvailableSlots: (...args: unknown[]) =>
      (h.getAvailableSlotsMock as unknown as (...x: unknown[]) => unknown)(...args),
  };
});

vi.mock("@/lib/appointments/booking", () => ({
  createAppointment: (...args: unknown[]) =>
    (h.createAppointmentMock as unknown as (...x: unknown[]) => unknown)(...args),
}));

import { dispatchInboundToFlows } from "./engine";

describe("Flow Engine: book_appointment Node", () => {
  const accountId = "acct-1";
  const contactId = "contact-1";
  const conversationId = "conv-1";
  const userId = "user-1";
  const flowId = "flow-1";

  const bookNode = {
    id: "fn-1",
    flow_id: flowId,
    node_key: "book_step",
    node_type: "book_appointment",
    config: {
      date_selection_days: 7,
      confirmation_message:
        "Confirmed {{appointment.service}} with {{appointment.staff}} on {{appointment.date}} at {{appointment.time}}! Ref: {{appointment.id}}",
      next_node_key: "done_step",
    },
  };

  const endNode = {
    id: "fn-2",
    flow_id: flowId,
    node_key: "done_step",
    node_type: "end",
    config: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.state.activeRuns = [];
    h.state.flows = [];
    h.state.nodes = [bookNode, endNode];
    h.state.messages = [];
    h.state.events = [];
    h.state.updates = [];
    h.state.services = [
      {
        id: "svc-1",
        account_id: accountId,
        name: "General Consultation",
        duration_minutes: 30,
        price: 500,
        currency: "INR",
        is_active: true,
      },
    ];
    h.state.staff = [
      {
        id: "staff-1",
        account_id: accountId,
        name: "Dr. Alice",
        is_active: true,
      },
    ];
    h.state.contacts = [
      {
        id: contactId,
        name: "John Doe",
        phone: "+919876543210",
      },
    ];
  });

  it("prompts for service when service_id is not yet set", async () => {
    h.state.activeRuns = [
      {
        id: "run-1",
        account_id: accountId,
        user_id: userId,
        contactId,
        contact_id: contactId,
        conversation_id: conversationId,
        flow_id: flowId,
        current_node_key: "book_step",
        status: "active",
        vars: {},
        reprompt_count: 0,
      },
    ];

    // Trigger an incoming text to an active run at book_step (or reprompt)
    const result = await dispatchInboundToFlows({
      accountId,
      contactId,
      conversationId,
      userId,
      isFirstInboundMessage: false,
      message: {
        kind: "text",
        text: "I want an appointment",
        meta_message_id: "wamid.in.1",
      },
    });

    expect(result.consumed).toBe(true);
    // Should have sent the services interactive list
    expect(h.sendList).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: "Please select a service for your appointment:",
        buttonLabel: "Select Service",
        sections: [
          {
            title: "Available Services",
            rows: [
              {
                id: "book_svc_svc-1",
                title: "General Consultation",
                description: "30 min • INR 500",
              },
            ],
          },
        ],
      }),
    );
  });

  it("handles book_svc_* reply, saves service and prompts for date", async () => {
    h.state.activeRuns = [
      {
        id: "run-1",
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        conversation_id: conversationId,
        flow_id: flowId,
        current_node_key: "book_step",
        status: "active",
        vars: {},
        reprompt_count: 0,
      },
    ];

    h.getAvailableDatesMock.mockResolvedValueOnce([
      {
        date: "2026-09-30",
        day_name: "Wednesday",
        available: true,
        slot_count: 4,
      },
    ]);

    const result = await dispatchInboundToFlows({
      accountId,
      contactId,
      conversationId,
      userId,
      isFirstInboundMessage: false,
      message: {
        kind: "interactive_reply",
        reply_id: "book_svc_svc-1",
        reply_title: "General Consultation",
        meta_message_id: "wamid.in.2",
      },
    });

    expect(result.consumed).toBe(true);
    // Active run vars should have booking_service_id
    expect(h.state.activeRuns[0].vars).toMatchObject({
      booking_service_id: "svc-1",
      booking_service_name: "General Consultation",
    });

    // Should prompt for date
    expect(h.sendList).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: "Please choose a date for your appointment:",
        buttonLabel: "Select Date",
        sections: [
          {
            title: "Available Dates",
            rows: [
              {
                id: "book_date_2026-09-30",
                title: "Wednesday, 2026-09-30",
                description: "4 slots available",
              },
            ],
          },
        ],
      }),
    );
  });

  it("handles book_date_* reply, saves date and prompts for slot", async () => {
    h.state.activeRuns = [
      {
        id: "run-1",
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        conversation_id: conversationId,
        flow_id: flowId,
        current_node_key: "book_step",
        status: "active",
        vars: {
          booking_service_id: "svc-1",
          booking_service_name: "General Consultation",
        },
        reprompt_count: 0,
      },
    ];

    h.getAvailableSlotsMock.mockResolvedValueOnce({
      slots: [
        {
          start: "10:00 AM",
          end: "10:30 AM",
          start_iso: "2026-09-30T10:00:00.000Z",
          available: true,
          staff_id: "staff-1",
          staff_name: "Dr. Alice",
        },
      ],
    });

    const result = await dispatchInboundToFlows({
      accountId,
      contactId,
      conversationId,
      userId,
      isFirstInboundMessage: false,
      message: {
        kind: "interactive_reply",
        reply_id: "book_date_2026-09-30",
        reply_title: "Wednesday, 2026-09-30",
        meta_message_id: "wamid.in.3",
      },
    });

    expect(result.consumed).toBe(true);
    expect(h.state.activeRuns[0].vars).toMatchObject({
      booking_date: "2026-09-30",
    });

    // Should prompt for time slot
    expect(h.sendList).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: "Available times for 2026-09-30:",
        buttonLabel: "Select Time",
        sections: [
          {
            title: "Available Slots",
            rows: [
              {
                id: "book_slot_2026-09-30T10:00:00.000Z|staff-1",
                title: "10:00 AM - 10:30 AM",
                description: "with Dr. Alice",
              },
            ],
          },
        ],
      }),
    );
  });

  it("handles book_slot_* reply, creates appointment, interpolates confirmation, and advances", async () => {
    h.state.activeRuns = [
      {
        id: "run-1",
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        conversation_id: conversationId,
        flow_id: flowId,
        current_node_key: "book_step",
        status: "active",
        vars: {
          booking_service_id: "svc-1",
          booking_service_name: "General Consultation",
          booking_date: "2026-09-30",
        },
        reprompt_count: 0,
      },
    ];

    h.createAppointmentMock.mockResolvedValueOnce({
      ok: true,
      appointment: {
        id: "apt-999",
        account_id: accountId,
        service_id: "svc-1",
        staff_id: "staff-1",
        start_at: "2026-09-30T10:00:00.000Z",
        end_at: "2026-09-30T10:30:00.000Z",
        customer_name: "John Doe",
        timezone: "UTC",
        staff: { name: "Dr. Alice" },
      },
    });

    const result = await dispatchInboundToFlows({
      accountId,
      contactId,
      conversationId,
      userId,
      isFirstInboundMessage: false,
      message: {
        kind: "interactive_reply",
        reply_id: "book_slot_2026-09-30T10:00:00.000Z|staff-1",
        reply_title: "10:00 AM - 10:30 AM",
        meta_message_id: "wamid.in.4",
      },
    });

    expect(result.consumed).toBe(true);

    // Verify createAppointment called
    expect(h.createAppointmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        serviceId: "svc-1",
        staffId: "staff-1",
        customerName: "John Doe",
        source: "whatsapp_flow",
        status: "confirmed",
      }),
    );

    // Verify confirmation message sent with interpolated values
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Confirmed General Consultation with Dr. Alice on 2026-09-30 at 10:00 AM - 10:30 AM! Ref: apt-999",
      }),
    );

    // Ephemeral variables cleaned up, appointment variables set
    const finalVars = h.state.activeRuns[0].vars as Record<string, unknown>;
    expect(finalVars.appointment_id).toBe("apt-999");
    expect(finalVars.appointment_service).toBe("General Consultation");
    expect(finalVars.appointment_staff).toBe("Dr. Alice");
    expect(finalVars.appointment_date).toBe("2026-09-30");
    expect(finalVars.booking_service_id).toBeUndefined();
    expect(finalVars.booking_date).toBeUndefined();
    expect(finalVars.booking_slot_start).toBeUndefined();

    // End node was reached (flow run completed)
    expect(h.state.activeRuns[0].status).toBe("completed");
  });

  it("handles double-booking slot collision by reprompting slot selection", async () => {
    h.state.activeRuns = [
      {
        id: "run-1",
        account_id: accountId,
        user_id: userId,
        contact_id: contactId,
        conversation_id: conversationId,
        flow_id: flowId,
        current_node_key: "book_step",
        status: "active",
        vars: {
          booking_service_id: "svc-1",
          booking_service_name: "General Consultation",
          booking_date: "2026-09-30",
        },
        reprompt_count: 0,
      },
    ];

    h.createAppointmentMock.mockResolvedValueOnce({
      ok: false,
      code: "SLOT_ALREADY_BOOKED",
      error: "This slot has already been booked.",
    });

    h.getAvailableSlotsMock.mockResolvedValueOnce({
      slots: [
        {
          start: "11:00 AM",
          end: "11:30 AM",
          start_iso: "2026-09-30T11:00:00.000Z",
          available: true,
          staff_id: "staff-1",
          staff_name: "Dr. Alice",
        },
      ],
    });

    const result = await dispatchInboundToFlows({
      accountId,
      contactId,
      conversationId,
      userId,
      isFirstInboundMessage: false,
      message: {
        kind: "interactive_reply",
        reply_id: "book_slot_2026-09-30T10:00:00.000Z|staff-1",
        reply_title: "10:00 AM - 10:30 AM",
        meta_message_id: "wamid.in.5",
      },
    });

    expect(result.consumed).toBe(true);

    // Informs user that the slot was just taken
    expect(h.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "That time slot was just booked by another customer. Please choose another time:",
      }),
    );

    // Slot options re-presented
    expect(h.sendList).toHaveBeenCalled();
  });
});
