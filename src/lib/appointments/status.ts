import type { AppointmentStatus } from "./types";

/**
 * Standardized machine-readable appointment error codes.
 */
export type AppointmentErrorCode =
  | "SLOT_UNAVAILABLE"
  | "SLOT_ALREADY_BOOKED"
  | "PROVIDER_NOT_ELIGIBLE"
  | "SERVICE_INACTIVE"
  | "STAFF_INACTIVE"
  | "STAFF_NOT_FOUND"
  | "SERVICE_NOT_FOUND"
  | "OUTSIDE_WORKING_HOURS"
  | "APPOINTMENT_NOT_RESCHEDULABLE"
  | "INVALID_STATUS_TRANSITION"
  | "INVALID_TIME_RANGE"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "DATABASE_ERROR";

/**
 * Valid lifecycle transitions for appointments.
 * Terminal states: completed, cancelled, rescheduled.
 */
export const VALID_STATUS_TRANSITIONS: Record<
  AppointmentStatus,
  readonly AppointmentStatus[]
> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "rescheduled", "no_show"],
  completed: [], // Terminal outcome
  cancelled: [], // Terminal outcome
  no_show: ["confirmed"], // Can be re-confirmed if customer returns
  rescheduled: [], // Terminal outcome (superseded by new linked appointment)
};

/**
 * Validates whether an appointment can transition from status `from` to status `to`.
 */
export function canTransitionStatus(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  if (from === to) return true;
  const allowed = VALID_STATUS_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Maps standard error codes to clear, human-friendly actionable messages.
 */
export function getActionableErrorMessage(
  code: AppointmentErrorCode,
  fallbackMsg?: string,
): string {
  switch (code) {
    case "SLOT_ALREADY_BOOKED":
    case "SLOT_UNAVAILABLE":
      return "This time slot is no longer available. Please select another time.";
    case "PROVIDER_NOT_ELIGIBLE":
      return "The selected provider is not authorized to perform this service.";
    case "SERVICE_INACTIVE":
      return "The requested service is currently inactive.";
    case "STAFF_INACTIVE":
      return "The requested provider is currently inactive.";
    case "OUTSIDE_WORKING_HOURS":
      return "The selected time is outside the provider's working hours.";
    case "APPOINTMENT_NOT_RESCHEDULABLE":
      return "This appointment cannot be rescheduled because it is already completed, cancelled, or rescheduled.";
    case "INVALID_STATUS_TRANSITION":
      return "This status change is not allowed for the appointment in its current state.";
    case "INVALID_TIME_RANGE":
      return "Appointments must have valid start and end times in the future.";
    case "NOT_FOUND":
      return "Appointment record not found.";
    case "UNAUTHORIZED":
      return "You do not have permission to perform this appointment action.";
    default:
      return fallbackMsg || "An error occurred with the appointment.";
  }
}
