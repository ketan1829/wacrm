import { beforeEach, describe, it, expect, vi } from "vitest";

// ============================================================
// Fakes for the interpolation tests at the bottom of this file
// (issue #553). Same shape as dispatch.test.ts: a minimal Supabase
// query-builder stand-in plus a stubbed meta-send, so we can drive the
// real `dispatchInboundToFlows` and assert on the payload that would
// have gone to Meta. vi.mock is hoisted above the imports below, so
// the pure-helper tests are unaffected — they never touch either.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    /** Rows loadActiveRunForContact sees. */
    activeRuns: [] as Record<string, unknown>[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    messages: [] as Record<string, unknown>[],
    /** flow_run_events INSERTs (what logEvent wrote). */
    events: [] as Record<string, unknown>[],
    /** Every UPDATE, by table. */
    updates: [] as { table: string; row: Record<string, unknown> }[],
  },
  sendButtons: vi.fn<
    (
      args: Parameters<typeof engineSendInteractiveButtons>[0],
    ) => Promise<{ whatsapp_message_id: string }>
  >(async () => ({ whatsapp_message_id: "wamid.3" })),
  sendList: vi.fn<
    (
      args: Parameters<typeof engineSendInteractiveList>[0],
    ) => Promise<{ whatsapp_message_id: string }>
  >(async () => ({ whatsapp_message_id: "wamid.4" })),
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "messages") return h.state.messages;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
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
        if (table === "messages" && h.state.messages[0]) {
          Object.assign(h.state.messages[0], row);
        }
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        if (table === "flow_run_events") h.state.events.push(row);
        return b;
      },
      maybeSingle: async () => ({ data: rows(table)[0] ?? null, error: null }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: {
          data: unknown[];
          error: null;
          count: number;
        }) => unknown,
      ) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.1" })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: h.sendButtons,
  engineSendInteractiveList: h.sendList,
}));

import {
  dispatchInboundToFlows,
  matchReplyId,
  findSelectedRow,
  findSelectedButton,
  resolveSelectedTitle,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
} from "./engine";
import type {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from "./meta-send";
import type { ParsedInbound } from "./types";

describe("matchReplyId", () => {
  it("returns null for nodes without options", () => {
    expect(
      matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y"),
    ).toBeNull();
    expect(
      matchReplyId({ node_type: "send_message", config: {} }, "y"),
    ).toBeNull();
    expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();
  });

  it("matches the buttons array on a send_buttons node", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick one",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
          { reply_id: "no", title: "No", next_node_key: "declined" },
        ],
      },
    };
    expect(matchReplyId(node, "yes")).toBe("confirmed");
    expect(matchReplyId(node, "no")).toBe("declined");
  });

  it("returns null when no button reply_id matches", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "a", title: "A", next_node_key: "to_a" },
          { reply_id: "b", title: "B", next_node_key: "to_b" },
        ],
      },
    };
    expect(matchReplyId(node, "c")).toBeNull();
    expect(matchReplyId(node, "")).toBeNull();
  });

  it("searches across all sections in a send_list node", () => {
    const node = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          {
            title: "Recent",
            rows: [
              { reply_id: "o1", title: "Order 1", next_node_key: "ord_1" },
            ],
          },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, "o1")).toBe("ord_1");
    expect(matchReplyId(node, "o2")).toBe("ord_2");
    expect(matchReplyId(node, "o3")).toBe("ord_3");
    expect(matchReplyId(node, "o99")).toBeNull();
  });

  it("returns null when send_list has no sections / empty sections", () => {
    expect(
      matchReplyId(
        { node_type: "send_list", config: { text: "x", sections: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: "send_list",
          config: { text: "x", sections: [{ rows: [] }] },
        },
        "x",
      ),
    ).toBeNull();
  });
});

describe("findSelectedRow, findSelectedButton, resolveSelectedTitle", () => {
  const listNode = {
    node_type: "send_list",
    config: {
      text: "Services",
      sections: [
        {
          title: "Dentistry",
          rows: [
            {
              reply_id: "dental_cleaning",
              title: "Dental Cleaning",
              description: "Routine cleaning",
              next_node_key: "step_cleaning",
            },
            {
              reply_id: "tooth_pain",
              title: "Tooth Pain",
              next_node_key: "step_pain",
            },
          ],
        },
      ],
    },
  };

  const buttonsNode = {
    node_type: "send_buttons",
    config: {
      text: "Confirm?",
      buttons: [
        { reply_id: "yes", title: "Yes, Confirm", next_node_key: "ok" },
        { reply_id: "no", title: "No, Cancel", next_node_key: "cancel" },
      ],
    },
  };

  it("findSelectedRow returns matching row or null", () => {
    expect(findSelectedRow(listNode, "dental_cleaning")).toEqual({
      reply_id: "dental_cleaning",
      title: "Dental Cleaning",
      description: "Routine cleaning",
      next_node_key: "step_cleaning",
    });
    expect(findSelectedRow(listNode, "unknown")).toBeNull();
    expect(findSelectedRow(buttonsNode, "yes")).toBeNull();
  });

  it("findSelectedButton returns matching button or null", () => {
    expect(findSelectedButton(buttonsNode, "yes")).toEqual({
      reply_id: "yes",
      title: "Yes, Confirm",
      next_node_key: "ok",
    });
    expect(findSelectedButton(buttonsNode, "unknown")).toBeNull();
    expect(findSelectedButton(listNode, "dental_cleaning")).toBeNull();
  });

  it("resolveSelectedTitle resolves human-readable title for list or button node", () => {
    expect(resolveSelectedTitle(listNode, "dental_cleaning")).toBe("Dental Cleaning");
    expect(resolveSelectedTitle(listNode, "tooth_pain")).toBe("Tooth Pain");
    expect(resolveSelectedTitle(listNode, "unknown")).toBeNull();

    expect(resolveSelectedTitle(buttonsNode, "yes")).toBe("Yes, Confirm");
    expect(resolveSelectedTitle(buttonsNode, "no")).toBe("No, Cancel");
    expect(resolveSelectedTitle(buttonsNode, "unknown")).toBeNull();
  });
});

describe("matchesKeywordTrigger", () => {
  it("returns false for empty text", () => {
    expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  });

  it("returns false when keywords array is empty", () => {
    expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ["support"] };
    expect(matchesKeywordTrigger("I need SUPPORT please", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Support is great", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Help me", cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ["help"], match_type: "exact" as const };
    expect(matchesKeywordTrigger("help", cfg)).toBe(true);
    expect(matchesKeywordTrigger("HELP", cfg)).toBe(true);
    expect(matchesKeywordTrigger("help me", cfg)).toBe(false);
  });

  it("case_sensitive=true preserves case", () => {
    const cfg = {
      keywords: ["Support"],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger("I need Support", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need support", cfg)).toBe(false);
  });

  it("matches any one of multiple keywords", () => {
    const cfg = { keywords: ["help", "support", "issue"] };
    expect(matchesKeywordTrigger("I have an issue", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need Help!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nothing to see here", cfg)).toBe(false);
  });

  it("skips empty strings in the keywords array", () => {
    const cfg = { keywords: ["", "support", ""] };
    expect(matchesKeywordTrigger("support center", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nope", cfg)).toBe(false);
  });
});

describe("node classification helpers", () => {
  it("isAutoAdvancing covers start + send_message + send_media + condition + set_tag", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("send_buttons")).toBe(false);
    expect(isAutoAdvancing("send_list")).toBe(false);
    expect(isAutoAdvancing("collect_input")).toBe(false);
    expect(isAutoAdvancing("handoff")).toBe(false);
    expect(isAutoAdvancing("end")).toBe(false);
  });

  it("isSuspending covers the input-requiring nodes", () => {
    expect(isSuspending("send_buttons")).toBe(true);
    expect(isSuspending("send_list")).toBe(true);
    expect(isSuspending("collect_input")).toBe(true);
    expect(isSuspending("start")).toBe(false);
    expect(isSuspending("send_message")).toBe(false);
    expect(isSuspending("condition")).toBe(false);
    expect(isSuspending("set_tag")).toBe(false);
    expect(isSuspending("handoff")).toBe(false);
    expect(isSuspending("end")).toBe(false);
  });

  it("isTerminal covers handoff + end", () => {
    expect(isTerminal("handoff")).toBe(true);
    expect(isTerminal("end")).toBe(true);
    expect(isTerminal("start")).toBe(false);
    expect(isTerminal("send_buttons")).toBe(false);
    expect(isTerminal("condition")).toBe(false);
  });

  it("the three classifications are mutually exclusive for known node types", () => {
    const types = [
      "start",
      "send_message",
      "send_buttons",
      "send_list",
      "send_media",
      "collect_input",
      "condition",
      "set_tag",
      "handoff",
      "end",
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("evaluateConditionPredicate", () => {
  it("present: true when subject has a value", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "alice@example.com",
        configValue: undefined,
      }),
    ).toBe(true);
  });

  it("present: false when subject is undefined or empty", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("absent: inverse of present", () => {
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: "x",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("equals: exact string comparison; case-sensitive", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "VIP",
        configValue: "VIP",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "vip",
        configValue: "VIP",
      }),
    ).toBe(false);
  });

  it("equals: undefined subject never matches (even against empty)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: undefined,
        configValue: "",
      }),
    ).toBe(false);
  });

  it("contains: substring match", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@example.com",
        configValue: "@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@other.com",
        configValue: "@example.com",
      }),
    ).toBe(false);
  });

  it("contains: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: undefined,
        configValue: "anything",
      }),
    ).toBe(false);
  });
});

// ============================================================
// {{vars.*}} interpolation in send_buttons / send_list (issue #553).
//
// A send_buttons node placed after a collect_input used to send
// "Hi {{vars.name}}" literally — only send_message, send_media
// captions and collect_input prompts were interpolated.
// ============================================================

const RUN = {
  id: "run-1",
  flow_id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  contact_id: "ct-1",
  conversation_id: "cv-1",
  status: "active",
  current_node_key: "ask_name",
  last_prompt_message_id: null,
  vars: {} as Record<string, unknown>,
  reprompt_count: 0,
  started_at: "2026-01-01T00:00:00Z",
  last_advanced_at: "2026-01-01T00:00:00Z",
  ended_at: null,
  end_reason: null,
};

const FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "manual",
  trigger_config: {},
  entry_node_id: "ask_name",
  fallback_policy: {
    on_unknown_reply: "reprompt",
    max_reprompts: 2,
    on_timeout_hours: 24,
    on_exhaust: "handoff",
  },
  created_at: "2026-01-01T00:00:00Z",
};

const BUTTONS_NODE = {
  id: "n2",
  flow_id: "flow-1",
  node_key: "choose",
  node_type: "send_buttons",
  config: {
    text: "Hi {{vars.name}}, please choose an option.",
    header_text: "Welcome {{vars.name}}",
    // footer_text deliberately absent — must stay absent, not become "".
    buttons: [
      { reply_id: "yes", title: "Yes, {{vars.name}}", next_node_key: "done" },
      // A reply_id is a routing key, not customer-visible text; it must
      // reach Meta exactly as authored even if it happens to look like a
      // template.
      { reply_id: "no_{{vars.name}}", title: "No thanks", next_node_key: "done" },
    ],
  },
};

const LIST_NODE = {
  id: "n3",
  flow_id: "flow-1",
  node_key: "pick",
  node_type: "send_list",
  config: {
    text: "{{vars.name}}, pick a plan.",
    button_label: "{{vars.name}}'s plans",
    footer_text: "Prices for {{vars.name}}",
    // header_text deliberately absent.
    sections: [
      {
        title: "Plans for {{vars.name}}",
        rows: [
          {
            reply_id: "basic",
            title: "Basic for {{vars.name}}",
            description: "Best for {{vars.name}}",
            next_node_key: "done",
          },
          // No description — must stay absent.
          { reply_id: "pro", title: "Pro", next_node_key: "done" },
        ],
      },
    ],
  },
};

/** collect_input "ask_name" → `next`, plus both interactive nodes + end. */
function nodesEndingIn(next: "choose" | "pick") {
  return [
    {
      id: "n1",
      flow_id: "flow-1",
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "What's your name?",
        var_key: "name",
        next_node_key: next,
      },
    },
    BUTTONS_NODE,
    LIST_NODE,
    { id: "n9", flow_id: "flow-1", node_key: "done", node_type: "end", config: {} },
  ];
}

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });
}

function text(t: string): ParsedInbound {
  return { kind: "text", text: t, meta_message_id: `m-${t}` };
}

describe("send_buttons / send_list interpolate {{vars.*}} (#553)", () => {
  beforeEach(() => {
    h.state.activeRuns = [{ ...RUN, vars: {} }];
    h.state.flows = [FLOW];
    h.state.nodes = nodesEndingIn("choose");
    h.state.events = [];
    h.state.updates = [];
  });

  it("send_buttons after collect_input renders body, header and button titles", async () => {
    const result = await dispatch(text("Alice"));

    expect(result).toMatchObject({ consumed: true, outcome: "advanced" });
    expect(h.sendButtons).toHaveBeenCalledTimes(1);
    const args = h.sendButtons.mock.calls[0][0];
    expect(args.bodyText).toBe("Hi Alice, please choose an option.");
    expect(args.headerText).toBe("Welcome Alice");
    expect(args.footerText).toBeUndefined();
    expect(args.buttons).toEqual([
      { id: "yes", title: "Yes, Alice" },
      { id: "no_{{vars.name}}", title: "No thanks" },
    ]);
    // The run really suspended on the buttons node.
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "flow_runs",
        row: expect.objectContaining({ current_node_key: "choose" }),
      }),
    );
  });

  it("send_list after collect_input renders body, button label, footer, section and row text", async () => {
    h.state.nodes = nodesEndingIn("pick");

    const result = await dispatch(text("Alice"));

    expect(result).toMatchObject({ consumed: true, outcome: "advanced" });
    expect(h.sendList).toHaveBeenCalledTimes(1);
    const args = h.sendList.mock.calls[0][0];
    expect(args.bodyText).toBe("Alice, pick a plan.");
    expect(args.buttonLabel).toBe("Alice's plans");
    expect(args.footerText).toBe("Prices for Alice");
    expect(args.headerText).toBeUndefined();
    expect(args.sections).toEqual([
      {
        title: "Plans for Alice",
        rows: [
          { id: "basic", title: "Basic for Alice", description: "Best for Alice" },
          { id: "pro", title: "Pro", description: undefined },
        ],
      },
    ]);
  });

  it("reprompt re-sends the interactive node with the same interpolation", async () => {
    // Run already suspended on the buttons node with the var captured;
    // the customer types instead of tapping → fallback → reprompt.
    h.state.activeRuns = [
      { ...RUN, current_node_key: "choose", vars: { name: "Alice" } },
    ];

    const result = await dispatch(text("huh?"));

    expect(result).toMatchObject({ consumed: true, outcome: "fallback_fired" });
    expect(h.sendButtons).toHaveBeenCalledTimes(1);
    expect(h.sendButtons.mock.calls[0][0].bodyText).toBe(
      "Hi Alice, please choose an option.",
    );
    expect(h.sendButtons.mock.calls[0][0].buttons[0]).toEqual({
      id: "yes",
      title: "Yes, Alice",
    });
  });

  it("a send failure (e.g. an interpolated title over Meta's limit) is logged and fails the run", async () => {
    // "Yes, Bartholomew Montgomery" is 27 chars; meta-api's validator
    // rejects titles over INTERACTIVE_LIMITS.buttonTitleMaxLength (20)
    // before calling Meta. The stub stands in for that throw.
    h.sendButtons.mockRejectedValueOnce(
      new Error(
        'Interactive button title "Yes, Bartholomew Montgomery" exceeds 20 chars.',
      ),
    );

    const result = await dispatch(text("Bartholomew Montgomery"));

    // Previously the throw escaped to dispatchInboundToFlows' catch:
    // consumed:false, nothing in flow_run_events, run left active.
    expect(result).toMatchObject({ consumed: true, outcome: "completed" });
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "error",
        node_key: "choose",
        payload: {
          reason: "send_buttons_failed",
          detail: expect.stringContaining("exceeds 20 chars"),
        },
      }),
    );
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "flow_runs",
        row: expect.objectContaining({
          status: "failed",
          end_reason: "send_buttons_failed",
        }),
      }),
    );
  });
});

describe("send_list variable capture, condition evaluation, and customer-facing title resolution", () => {
  const DENTAL_LIST_NODE = {
    id: "n-dental-list",
    flow_id: "flow-dental",
    node_key: "select_service",
    node_type: "send_list",
    config: {
      text: "Please select an appointment option:",
      button_label: "View options",
      var_key: "appointment_type",
      sections: [
        {
          title: "Dental Services",
          rows: [
            {
              reply_id: "dental_cleaning",
              title: "Dental Cleaning",
              description: "Routine dental cleaning",
              next_node_key: "check_condition",
            },
            {
              reply_id: "tooth_pain",
              title: "Tooth Pain",
              description: "Emergency pain check",
              next_node_key: "other_branch",
            },
            {
              reply_id: "root_canal",
              title: "Root Canal",
              description: "Endodontic therapy",
              next_node_key: "other_branch",
            },
          ],
        },
      ],
    },
  };

  const CONDITION_NODE = {
    id: "n-condition",
    flow_id: "flow-dental",
    node_key: "check_condition",
    node_type: "condition",
    config: {
      subject: "var",
      subject_key: "appointment_type",
      operator: "equals",
      value: "dental_cleaning",
      true_next: "confirmed_node",
      false_next: "other_branch",
    },
  };

  const CONFIRMED_NODE = {
    id: "n-confirmed",
    flow_id: "flow-dental",
    node_key: "confirmed_node",
    node_type: "send_message",
    config: {
      text: "Appointment for {{vars.appointment_type}} confirmed!",
      next_node_key: "end_node",
    },
  };

  const OTHER_NODE = {
    id: "n-other",
    flow_id: "flow-dental",
    node_key: "other_branch",
    node_type: "send_message",
    config: {
      text: "Other branch reached",
      next_node_key: "end_node",
    },
  };

  const END_NODE = {
    id: "n-end",
    flow_id: "flow-dental",
    node_key: "end_node",
    node_type: "end",
    config: {},
  };

  const DENTAL_FLOW = {
    id: "flow-dental",
    account_id: "acct-1",
    user_id: "u-1",
    status: "active",
    trigger_type: "manual",
    trigger_config: {},
    entry_node_id: "select_service",
    fallback_policy: {
      on_unknown_reply: "reprompt",
      max_reprompts: 2,
      on_timeout_hours: 24,
      on_exhaust: "handoff",
    },
    created_at: "2026-01-01T00:00:00Z",
  };

  const DENTAL_RUN = {
    id: "run-dental-1",
    flow_id: "flow-dental",
    account_id: "acct-1",
    user_id: "u-1",
    contact_id: "ct-1",
    conversation_id: "cv-1",
    status: "active",
    current_node_key: "select_service",
    last_prompt_message_id: null,
    vars: {} as Record<string, unknown>,
    reprompt_count: 0,
    started_at: "2026-01-01T00:00:00Z",
    last_advanced_at: "2026-01-01T00:00:00Z",
    ended_at: null,
    end_reason: null,
  };

  beforeEach(() => {
    h.state.activeRuns = [{ ...DENTAL_RUN, vars: {} }];
    h.state.flows = [DENTAL_FLOW];
    h.state.nodes = [
      DENTAL_LIST_NODE,
      CONDITION_NODE,
      CONFIRMED_NODE,
      OTHER_NODE,
      END_NODE,
    ];
    h.state.events = [];
    h.state.updates = [];
    h.state.messages = [
      {
        id: "msg-inbound-1",
        message_id: "wamid.inbound.1",
        conversation_id: "cv-1",
        content_text: "dental_cleaning",
        interactive_reply_id: "dental_cleaning",
      },
    ];
  });

  it("Test C & D & E & F: captures variable, routes, condition evaluates true, repairs display text", async () => {
    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "dental_cleaning",
        reply_title: "dental_cleaning",
        meta_message_id: "wamid.inbound.1",
      },
      isFirstInboundMessage: false,
    });

    expect(result).toMatchObject({ consumed: true, outcome: "completed" });

    // 1. Variable storage: persisted to flow_runs.vars
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "flow_runs",
        row: expect.objectContaining({
          vars: { appointment_type: "dental_cleaning" },
          reprompt_count: 0,
        }),
      }),
    );

    // 2. In-memory run.vars is updated with internal identifier
    const runRow = h.state.activeRuns[0] as { vars: Record<string, unknown> };
    expect(runRow.vars.appointment_type).toBe("dental_cleaning");

    // 3. Condition node evaluated true (appointment_type == dental_cleaning)
    // and advanced through condition to confirmed_node
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "node_entered",
        node_key: "check_condition",
        payload: expect.objectContaining({
          condition_result: "true",
          advancing_to: "confirmed_node",
        }),
      }),
    );

    // 4. Customer-facing display text in messages table repaired to "Dental Cleaning"
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "messages",
        row: { content_text: "Dental Cleaning" },
      }),
    );

    // 5. Conversation last_message_text updated to "Dental Cleaning"
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "conversations",
        row: expect.objectContaining({
          last_message_text: "Dental Cleaning",
        }),
      }),
    );

    // 6. reply_received event includes resolved reply_title and internal reply_id
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "reply_received",
        node_key: "select_service",
        payload: expect.objectContaining({
          reply_id: "dental_cleaning",
          reply_title: "Dental Cleaning",
        }),
      }),
    );

    // 7. node_entered event logged captured_key
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "node_entered",
        node_key: "select_service",
        payload: expect.objectContaining({
          captured_key: "appointment_type",
          captured_value: "dental_cleaning",
          selected_title: "Dental Cleaning",
        }),
      }),
    );
  });

  it("Test G: send_list with no var_key routes normally without writing a variable", async () => {
    const noVarListNode = {
      ...DENTAL_LIST_NODE,
      config: {
        ...DENTAL_LIST_NODE.config,
        var_key: "",
      },
    };
    h.state.nodes = [noVarListNode, CONDITION_NODE, CONFIRMED_NODE, OTHER_NODE, END_NODE];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "dental_cleaning",
        reply_title: "dental_cleaning",
        meta_message_id: "wamid.inbound.1",
      },
      isFirstInboundMessage: false,
    });

    expect(result).toMatchObject({ consumed: true, outcome: "completed" });

    // No variable was written to vars
    const runRow = h.state.activeRuns[0] as { vars: Record<string, unknown> };
    expect(runRow.vars.appointment_type).toBeUndefined();

    // Normal routing to check_condition still occurred
    expect(h.state.events).toContainEqual(
      expect.objectContaining({
        event_type: "node_entered",
        node_key: "check_condition",
      }),
    );

    // Title resolution still repaired the message to "Dental Cleaning"
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "messages",
        row: { content_text: "Dental Cleaning" },
      }),
    );
  });

  it("Test H: existing send_buttons behavior is unaffected", async () => {
    const BUTTON_RUN = {
      ...DENTAL_RUN,
      current_node_key: "choose_btn",
    };
    const BTN_NODE = {
      id: "n-btn",
      flow_id: "flow-dental",
      node_key: "choose_btn",
      node_type: "send_buttons",
      config: {
        text: "Please confirm:",
        buttons: [
          { reply_id: "yes", title: "Yes, Confirm", next_node_key: "confirmed_node" },
          { reply_id: "no", title: "No, Cancel", next_node_key: "other_branch" },
        ],
      },
    };

    h.state.activeRuns = [BUTTON_RUN];
    h.state.nodes = [BTN_NODE, CONFIRMED_NODE, OTHER_NODE, END_NODE];
    h.state.messages = [
      {
        id: "msg-inbound-1",
        message_id: "wamid.inbound.1",
        conversation_id: "cv-1",
        content_text: "yes",
        interactive_reply_id: "yes",
      },
    ];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "yes",
        reply_title: "yes",
        meta_message_id: "wamid.inbound.1",
      },
      isFirstInboundMessage: false,
    });

    expect(result).toMatchObject({ consumed: true, outcome: "completed" });
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        table: "messages",
        row: { content_text: "Yes, Confirm" },
      }),
    );
  });

  it("Step 12: interpolation {{vars.appointment_type}} renders the internal value dental_cleaning", async () => {
    const { engineSendText } = await import("./meta-send");
    // Start at confirmed_node which sends "Appointment for {{vars.appointment_type}} confirmed!"
    h.state.activeRuns = [
      {
        ...DENTAL_RUN,
        current_node_key: "select_service",
      },
    ];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "dental_cleaning",
        reply_title: "Dental Cleaning",
        meta_message_id: "wamid.inbound.1",
      },
      isFirstInboundMessage: false,
    });

    // In confirmed_node, text should interpolate to "dental_cleaning"
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Appointment for dental_cleaning confirmed!",
      }),
    );
  });
});
