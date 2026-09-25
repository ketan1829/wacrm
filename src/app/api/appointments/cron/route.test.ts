import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  processReminders: vi.fn(),
}));

vi.mock("@/lib/appointments/reminders", () => ({
  processAppointmentReminders: h.processReminders,
}));

import { GET } from "./route";

describe("GET /api/appointments/cron", () => {
  const originalSecret = process.env.AUTOMATION_CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTOMATION_CRON_SECRET = "secret-key-12345";
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.AUTOMATION_CRON_SECRET = originalSecret;
    } else {
      delete process.env.AUTOMATION_CRON_SECRET;
    }
  });

  it("returns 503 if AUTOMATION_CRON_SECRET is not configured", async () => {
    delete process.env.AUTOMATION_CRON_SECRET;

    const req = new Request("http://localhost:3000/api/appointments/cron", {
      method: "GET",
      headers: { "x-cron-secret": "secret-key-12345" },
    });

    const res = await GET(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("cron not configured");
    expect(h.processReminders).not.toHaveBeenCalled();
  });

  it("returns 401 if x-cron-secret header is missing", async () => {
    const req = new Request("http://localhost:3000/api/appointments/cron", {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(h.processReminders).not.toHaveBeenCalled();
  });

  it("returns 401 if x-cron-secret header is incorrect", async () => {
    const req = new Request("http://localhost:3000/api/appointments/cron", {
      method: "GET",
      headers: { "x-cron-secret": "wrong-secret" },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(h.processReminders).not.toHaveBeenCalled();
  });

  it("returns 200 and processes reminders when x-cron-secret matches", async () => {
    h.processReminders.mockResolvedValueOnce({
      processed24h: 3,
      processed2h: 1,
      errors: [],
    });

    const req = new Request("http://localhost:3000/api/appointments/cron", {
      method: "GET",
      headers: { "x-cron-secret": "secret-key-12345" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      processed24h: 3,
      processed2h: 1,
      errors: [],
    });
    expect(h.processReminders).toHaveBeenCalledTimes(1);
    expect(h.processReminders).toHaveBeenCalledWith();
  });
});
