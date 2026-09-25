"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import type { AppointmentStaff, AppointmentService } from "@/lib/appointments/types";

interface StaffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff?: AppointmentStaff | null;
  services: AppointmentService[];
  onSaved: () => void;
}

const PRESET_COLORS = [
  "#3b82f6", // Blue
  "#10b981", // Emerald
  "#8b5cf6", // Purple
  "#f59e0b", // Amber
  "#ef4444", // Red
  "#ec4899", // Pink
  "#06b6d4", // Cyan
  "#6366f1", // Indigo
];

export function StaffDialog({
  open,
  onOpenChange,
  staff,
  services,
  onSaved,
}: StaffDialogProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [isActive, setIsActive] = useState(true);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (staff) {
      setName(staff.name);
      setEmail(staff.email || "");
      setPhone(staff.phone || "");
      setColor(staff.color || "#3b82f6");
      setIsActive(staff.is_active);
      setSelectedServiceIds(staff.service_ids || []);
    } else {
      setName("");
      setEmail("");
      setPhone("");
      setColor("#3b82f6");
      setIsActive(true);
      setSelectedServiceIds(services.map((s) => s.id));
    }
  }, [staff, services, open]);

  const toggleService = (serviceId: string) => {
    setSelectedServiceIds((prev) =>
      prev.includes(serviceId)
        ? prev.filter((id) => id !== serviceId)
        : [...prev, serviceId],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Please enter a staff member name");
      return;
    }

    setSubmitting(true);
    try {
      const url = staff
        ? `/api/appointments/staff/${staff.id}`
        : "/api/appointments/staff";
      const method = staff ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          color,
          is_active: isActive,
          service_ids: selectedServiceIds,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save staff member");
      }

      toast.success(staff ? "Staff provider updated" : "Staff provider added");
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error saving staff";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {staff ? "Edit Staff Provider" : "Add Staff Provider"}
          </DialogTitle>
          <DialogDescription>
            Providers can be booked for services and have individual working hours.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="staff-name">Full Name / Title *</Label>
            <Input
              id="staff-name"
              placeholder="e.g. Dr. Ketan, Dr. Priya"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="staff-email">Email</Label>
              <Input
                id="staff-email"
                type="email"
                placeholder="doctor@clinic.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="staff-phone">Phone</Label>
              <Input
                id="staff-phone"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          {/* Color Selection */}
          <div className="space-y-1.5">
            <Label>Calendar Color</Label>
            <div className="flex items-center gap-2 pt-1">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full border-2 transition-transform ${
                    color === c ? "scale-110 border-foreground shadow-sm" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Assigned Services */}
          <div className="space-y-2 pt-2 border-t">
            <Label>Services Offered</Label>
            <p className="text-xs text-muted-foreground">
              Select which services this provider can perform:
            </p>
            <div className="space-y-2 max-h-36 overflow-y-auto rounded-md border p-2 bg-muted/20">
              {services.length === 0 && (
                <div className="text-xs text-muted-foreground py-2 text-center">
                  No services created yet. Create a service first.
                </div>
              )}
              {services.map((srv) => (
                <div key={srv.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`srv-${srv.id}`}
                    checked={selectedServiceIds.includes(srv.id)}
                    onCheckedChange={() => toggleService(srv.id)}
                  />
                  <label
                    htmlFor={`srv-${srv.id}`}
                    className="text-xs font-medium cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    {srv.name} ({srv.duration_minutes} min)
                  </label>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="staff-active" className="text-sm font-medium">
                Active Provider
              </Label>
              <p className="text-xs text-muted-foreground">
                Available to be scheduled for appointments
              </p>
            </div>
            <Switch
              id="staff-active"
              checked={isActive}
              onCheckedChange={setIsActive}
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
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Provider"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
