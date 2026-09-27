"use client";

import { useState, useEffect } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Calendar as CalendarIcon,
  Clock,
  User,
  Phone,
  Tag,
  Loader2,
  Check,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  Appointment,
  AppointmentService,
  AppointmentStaff,
  TimeSlot,
} from "@/lib/appointments/types";

interface AppointmentBookingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBooked: () => void;
  preselectedDate?: string;
  preselectedStaffId?: string;
  preselectedContactId?: string;
  preselectedContactName?: string;
  preselectedContactPhone?: string;
  rescheduleAppointment?: Appointment | null;
}

export function AppointmentBookingModal({
  open,
  onOpenChange,
  onBooked,
  preselectedDate,
  preselectedStaffId,
  preselectedContactId,
  preselectedContactName,
  preselectedContactPhone,
  rescheduleAppointment,
}: AppointmentBookingModalProps) {
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [staffList, setStaffList] = useState<AppointmentStaff[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [selectedStaffId, setSelectedStaffId] = useState<string>("any");
  const [selectedDate, setSelectedDate] = useState<string>(
    preselectedDate || format(new Date(), "yyyy-MM-dd"),
  );
  const [availableSlots, setAvailableSlots] = useState<TimeSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Customer & reschedule fields
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isReschedule = Boolean(rescheduleAppointment);

  // Load services and staff on open
  useEffect(() => {
    if (!open) return;

    const loadMeta = async () => {
      try {
        const [servicesRes, staffRes] = await Promise.all([
          fetch("/api/appointments/services"),
          fetch("/api/appointments/staff"),
        ]);
        const servicesData = await servicesRes.json();
        const staffData = await staffRes.json();

        if (servicesData.services) {
          const active = servicesData.services.filter(
            (s: AppointmentService) => s.is_active,
          );
          setServices(active);
          if (active.length > 0 && !selectedServiceId) {
            setSelectedServiceId(
              rescheduleAppointment?.service_id || active[0].id,
            );
          }
        }
        if (staffData.staff) {
          setStaffList(
            staffData.staff.filter((s: AppointmentStaff) => s.is_active),
          );
        }
      } catch (e) {
        console.error("Failed to load booking metadata:", e);
      }
    };

    loadMeta();
  }, [open, rescheduleAppointment]);

  // Update prefilled values
  useEffect(() => {
    if (rescheduleAppointment) {
      setSelectedServiceId(rescheduleAppointment.service_id);
      setSelectedStaffId(rescheduleAppointment.staff_id || "any");
      setCustomerName(rescheduleAppointment.customer_name);
      setCustomerPhone(rescheduleAppointment.customer_phone);
      setNotes(rescheduleAppointment.notes || "");
    } else {
      if (preselectedDate) setSelectedDate(preselectedDate);
      if (preselectedStaffId) setSelectedStaffId(preselectedStaffId);
      if (preselectedContactName) setCustomerName(preselectedContactName);
      if (preselectedContactPhone) setCustomerPhone(preselectedContactPhone);
    }
  }, [
    open,
    rescheduleAppointment,
    preselectedDate,
    preselectedStaffId,
    preselectedContactName,
    preselectedContactPhone,
  ]);

  // Fetch slots whenever service, staff, or date changes
  useEffect(() => {
    if (!open || !selectedServiceId || !selectedDate) return;

    let cancelled = false;
    const fetchSlots = async () => {
      setLoadingSlots(true);
      setSelectedSlot(null);
      try {
        const staffParam =
          selectedStaffId && selectedStaffId !== "any"
            ? `&staff_id=${selectedStaffId}`
            : "";
        const res = await fetch(
          `/api/appointments/availability?service_id=${selectedServiceId}&date=${selectedDate}${staffParam}`,
        );
        const data = await res.json();
        if (!cancelled && data.slots) {
          setAvailableSlots(data.slots);
        }
      } catch (err) {
        console.error("Failed to fetch slots:", err);
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    };

    fetchSlots();
    return () => {
      cancelled = true;
    };
  }, [open, selectedServiceId, selectedStaffId, selectedDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedServiceId || !selectedSlot) {
      toast.error("Please select a service and an available time slot");
      return;
    }

    if (!isReschedule && (!customerName.trim() || !customerPhone.trim())) {
      toast.error("Please fill in customer name and phone number");
      return;
    }

    setSubmitting(true);
    try {
      if (isReschedule && rescheduleAppointment) {
        // Atomic Reschedule Endpoint
        const res = await fetch(
          `/api/appointments/${rescheduleAppointment.id}/reschedule`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              new_start_at: selectedSlot.start_iso,
              new_end_at: selectedSlot.end_iso,
              staff_id: selectedSlot.staff_id,
              reschedule_reason: rescheduleReason.trim() || "Rescheduled by staff",
            }),
          },
        );

        const data = await res.json();
        if (!res.ok) {
          if (data.code === "SLOT_ALREADY_BOOKED") {
            toast.error(
              "This slot was just booked by someone else! Please choose another slot.",
            );
            setSelectedSlot(null);
            return;
          }
          throw new Error(data.error || "Failed to reschedule appointment");
        }

        toast.success("Appointment rescheduled successfully!");
      } else {
        // Create Appointment Endpoint
        const res = await fetch("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_id: selectedServiceId,
            staff_id:
              selectedStaffId !== "any" ? selectedStaffId : selectedSlot.staff_id,
            start_at: selectedSlot.start_iso,
            end_at: selectedSlot.end_iso,
            customer_name: customerName.trim(),
            customer_phone: customerPhone.trim(),
            contact_id: preselectedContactId || null,
            notes: notes.trim() || null,
            source: "dashboard",
            status: "confirmed",
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          if (data.code === "SLOT_ALREADY_BOOKED") {
            toast.error(
              "This slot was just booked by someone else! Please choose another slot.",
            );
            setSelectedSlot(null);
            return;
          }
          throw new Error(data.error || "Failed to create booking");
        }

        toast.success("Appointment booked successfully!");
      }

      onOpenChange(false);
      onBooked();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Booking error";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isReschedule ? "Reschedule Appointment" : "New Appointment"}
          </DialogTitle>
          <DialogDescription>
            {isReschedule
              ? "Select a new available date and time slot. Full history is preserved."
              : "Schedule a confirmed appointment with real-time slot checking."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Service Selector */}
          <div className="space-y-1.5">
            <Label htmlFor="service-select">Service *</Label>
            <Select
              value={selectedServiceId}
              onValueChange={(v) => v && setSelectedServiceId(v)}
              disabled={isReschedule}
            >
              <SelectTrigger id="service-select">
                <SelectValue placeholder="Select a service" />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.duration_minutes} min)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Staff Selector */}
          <div className="space-y-1.5">
            <Label htmlFor="staff-select">Provider</Label>
            <Select
              value={selectedStaffId}
              onValueChange={(v) => v && setSelectedStaffId(v)}
            >
              <SelectTrigger id="staff-select">
                <SelectValue placeholder="Any Available Provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any Available Provider</SelectItem>
                {staffList.map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: st.color }}
                      />
                      <span>{st.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Picker */}
          <div className="space-y-1.5">
            <Label htmlFor="booking-date">Date *</Label>
            <Input
              id="booking-date"
              type="date"
              value={selectedDate}
              min={format(new Date(), "yyyy-MM-dd")}
              onChange={(e) => setSelectedDate(e.target.value)}
              required
            />
          </div>

          {/* Time Slot Picker */}
          <div className="space-y-1.5">
            <Label>Available Time Slots *</Label>
            {loadingSlots ? (
              <div className="flex items-center justify-center p-6 border rounded-lg bg-muted/20 text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Finding bookable slots...
              </div>
            ) : availableSlots.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                No slots available on this date for the selected provider.
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto p-1 border rounded-lg">
                {availableSlots.map((slot) => {
                  const isSelected =
                    selectedSlot?.start_iso === slot.start_iso &&
                    selectedSlot?.staff_id === slot.staff_id;
                  return (
                    <button
                      key={`${slot.start_iso}-${slot.staff_id}`}
                      type="button"
                      disabled={!slot.available}
                      onClick={() => setSelectedSlot(slot)}
                      className={`p-2 text-xs rounded border transition-all text-left flex flex-col justify-between ${
                        !slot.available
                          ? "opacity-35 cursor-not-allowed bg-muted/40"
                          : isSelected
                            ? "border-primary bg-primary/10 text-primary font-semibold ring-1 ring-primary"
                            : "hover:border-primary/50 bg-card hover:bg-muted/20"
                      }`}
                    >
                      <span className="font-medium">{slot.start}</span>
                      <span className="text-[10px] text-muted-foreground truncate">
                        {slot.staff_name}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Reschedule Reason (if in reschedule mode) */}
          {isReschedule && (
            <div className="space-y-1.5">
              <Label htmlFor="reschedule-reason">Reason for Rescheduling</Label>
              <Input
                id="reschedule-reason"
                placeholder="e.g. Customer requested, doctor schedule change..."
                value={rescheduleReason}
                onChange={(e) => setRescheduleReason(e.target.value)}
              />
            </div>
          )}

          {/* Customer Details (only for new booking) */}
          {!isReschedule && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cust-name">Customer Name *</Label>
                  <Input
                    id="cust-name"
                    placeholder="Full name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cust-phone">WhatsApp Phone *</Label>
                  <Input
                    id="cust-phone"
                    placeholder="+919876543210"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="booking-notes">Notes (optional)</Label>
                <Textarea
                  id="booking-notes"
                  placeholder="Special instructions or preferences..."
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !selectedSlot}>
              {submitting ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {isReschedule ? "Rescheduling..." : "Booking..."}
                </span>
              ) : isReschedule ? (
                "Confirm Reschedule"
              ) : (
                "Create Appointment"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
