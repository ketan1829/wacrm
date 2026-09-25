import type { Contact } from "@/types";

export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show"
  | "rescheduled";

export type AppointmentSource =
  | "dashboard"
  | "whatsapp_flow"
  | "whatsapp_ai"
  | "api"
  | "manual";

export interface AppointmentService {
  id: string;
  account_id: string;
  name: string;
  description?: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  price: number;
  currency: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AppointmentStaff {
  id: string;
  account_id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  user_id?: string | null;
  color: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  services?: AppointmentService[];
  service_ids?: string[];
}

export interface AppointmentStaffService {
  staff_id: string;
  service_id: string;
  created_at: string;
}

export interface AppointmentAvailability {
  id: string;
  account_id: string;
  staff_id: string;
  day_of_week: number; // 0=Sunday, 1=Monday, ..., 6=Saturday
  start_time: string; // "09:00:00" or "09:00"
  end_time: string; // "17:00:00" or "17:00"
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface AppointmentAvailabilityException {
  id: string;
  account_id: string;
  staff_id?: string | null;
  exception_date: string; // "YYYY-MM-DD"
  is_unavailable: boolean;
  start_time?: string | null;
  end_time?: string | null;
  reason?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  account_id: string;
  contact_id?: string | null;
  conversation_id?: string | null;
  service_id: string;
  staff_id: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  customer_name: string;
  customer_phone: string;
  notes?: string | null;
  cancellation_reason?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  rescheduled_from_id?: string | null;
  rescheduled_to_id?: string | null;
  reminder_sent_24h?: boolean;
  reminder_sent_2h?: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  // Joined relation fields
  service?: AppointmentService;
  staff?: AppointmentStaff;
  contact?: Contact;
}

export interface TimeSlot {
  start: string; // e.g. "11:30"
  end: string; // e.g. "12:15"
  start_iso: string; // Full ISO 8601 UTC string
  end_iso: string; // Full ISO 8601 UTC string
  available: boolean;
  staff_id: string;
  staff_name: string;
}

export interface AvailableDate {
  date: string; // "YYYY-MM-DD"
  day_name: string; // "Monday", etc.
  available: boolean;
  slot_count: number;
}

export interface CreateAppointmentInput {
  accountId: string;
  serviceId: string;
  staffId: string;
  startAt: string; // ISO UTC or Date
  endAt: string; // ISO UTC or Date
  customerName: string;
  customerPhone: string;
  timezone?: string;
  contactId?: string | null;
  conversationId?: string | null;
  notes?: string | null;
  source?: AppointmentSource;
  status?: AppointmentStatus;
  createdBy?: string | null;
}

export interface RescheduleAppointmentInput {
  appointmentId: string;
  accountId: string;
  newStartAt: string;
  newEndAt: string;
  staffId?: string;
  reason?: string;
  cancelledBy?: string;
}

export interface CancelAppointmentInput {
  appointmentId: string;
  accountId: string;
  reason?: string;
  cancelledBy?: string;
}
