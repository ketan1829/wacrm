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
  AppointmentService,
  AppointmentStaff,
  TimeSlot,
  AvailableDate,
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
}: AppointmentBookingModalProps) {
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [staffList, setStaffList] = useState<AppointmentStaff[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [selectedStaffId, setSelectedStaffId] = useState<string>(preselectedStaffId || "any");
  const [selectedDate, setSelectedDate] = useState<string>(
    preselectedDate || format(new Date(), "yyyy-MM-dd"),
  );
  const [availableSlots, setAvailableSlots] = useState<TimeSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Customer fields
  const [customerName, setCustomerName] = useState(preselectedContactName || "");
  const [customerPhone, setCustomerPhone] = useState(preselectedContactPhone || "");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
          const active = servicesData.services.filter((s: AppointmentService) => s.is_active);
          setServices(active);
          if (active.length > 0 && !selectedServiceId) {
            setSelectedServiceId(active[0].id);
          }
        }
        if (staffData.staff) {
          setStaffList(staffData.staff.filter((s: AppointmentStaff) => s.is_active));
        }
      } catch (e) {
        console.error("Failed to load booking metadata:", e);
      }
    };

    loadMeta();
  }, [open]);

  // Update prefilled values when props change
  useEffect(() => {
    if (preselectedDate) setSelectedDate(preselectedDate);
    if (preselectedStaffId) setSelectedStaffId(preselectedStaffId);
    if (preselectedContactName) setCustomerName(preselectedContactName);
    if (preselectedContactPhone) setCustomerPhone(preselectedContactPhone);
  }, [preselectedDate, preselectedStaffId, preselectedContactName, preselectedContactPhone]);

  // Fetch slots whenever service, staff, or date changes
  useEffect(() => {
    if (!open || !selectedServiceId || !selectedDate) return;

    let cancelled = false;
    const fetchSlots = async () => {
      setLoadingSlots(true);
      setSelectedSlot(null);
      try {
        const staffParam = selectedStaffId && selectedStaffId !== "any" ? `&staff_id=${selectedStaffId}` : "";
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
    if (!selectedServiceId || !selectedSlot || !customerName.trim() || !customerPhone.trim()) {
      toast.error("Please fill in all required fields and select an available time slot");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: selectedServiceId,
          staff_id: selectedSlot.staff_id,
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
          toast.error("This slot was just booked by someone else! Please pick another.");
          // Refresh slots
          setSelectedSlot(null);
          return;
        }
        throw new Error(data.error || "Failed to create booking");
      }

      toast.success("Appointment booked successfully!");
      onOpenChange(false);
      onBooked();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Booking error";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedService = services.find((s) => s.id === selectedServiceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Appointment</DialogTitle>
          <DialogDescription>
            Schedule a confirmed appointment with real-time slot checking.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {/* Service Selector */}
          <div className="space-y-1.5">
            <Label htmlFor="service-select">Service *</Label>
            <Select value={selectedServiceId} onValueChange={(v) => v && setSelectedServiceId(v)}>
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
            <Select value={selectedStaffId} onValueChange={(v) => v && setSelectedStaffId(v)}>
              <SelectTrigger id="staff-select">
                <SelectValue placeholder="Any Available Provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any Available Provider</SelectItem>
                {staffList.map((st) => (
                  <SelectItem key={st.id} value={st.id}>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full inline-block"
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
            <Label htmlFor="date-input">Date *</Label>
            <Input
              id="date-input"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              min={format(new Date(), "yyyy-MM-dd")}
            />
          </div>

          {/* Available Slots Grid */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Select Time Slot *</Label>
              {loadingSlots && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking availability...
                </div>
              )}
            </div>

            {!loadingSlots && availableSlots.length === 0 && (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No slots available on this date. Try another date or provider.
              </div>
            )}

            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto p-1">
              {availableSlots.map((slot) => {
                const isSelected = selectedSlot?.start === slot.start;
                return (
                  <button
                    key={slot.start}
                    type="button"
                    disabled={!slot.available}
                    onClick={() => setSelectedSlot(slot)}
                    className={`rounded-md border p-2 text-xs font-medium transition-all text-center relative ${
                      !slot.available
                        ? "opacity-30 bg-muted cursor-not-allowed line-through"
                        : isSelected
                          ? "border-primary bg-primary text-primary-foreground shadow-sm"
                          : "border-border bg-card hover:border-primary/50 hover:bg-muted/50 text-foreground"
                    }`}
                  >
                    <div>{slot.start}</div>
                    {slot.staff_name && selectedStaffId === "any" && (
                      <div className="text-[10px] opacity-75 truncate mt-0.5">
                        {slot.staff_name}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {selectedSlot && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                ✓ Selected: {selectedSlot.start} – {selectedSlot.end} with {selectedSlot.staff_name}
              </p>
            )}
          </div>

          {/* Customer Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
            <div className="space-y-1.5">
              <Label htmlFor="customer-name">Customer Name *</Label>
              <Input
                id="customer-name"
                placeholder="Rahul Sharma"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customer-phone">WhatsApp Phone *</Label>
              <Input
                id="customer-phone"
                placeholder="+91 98765 43210"
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
              placeholder="Special instructions or customer requests..."
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !selectedSlot || !customerName || !customerPhone}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Reserving...
                </>
              ) : (
                "Confirm Booking"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
