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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import type { AppointmentService } from "@/lib/appointments/types";

interface ServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service?: AppointmentService | null;
  onSaved: () => void;
}

export function ServiceDialog({
  open,
  onOpenChange,
  service,
  onSaved,
}: ServiceDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [bufferBefore, setBufferBefore] = useState(0);
  const [bufferAfter, setBufferAfter] = useState(0);
  const [price, setPrice] = useState(0);
  const [currency, setCurrency] = useState("INR");
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (service) {
      setName(service.name);
      setDescription(service.description || "");
      setDurationMinutes(service.duration_minutes);
      setBufferBefore(service.buffer_before_minutes || 0);
      setBufferAfter(service.buffer_after_minutes || 0);
      setPrice(service.price);
      setCurrency(service.currency || "INR");
      setIsActive(service.is_active);
    } else {
      setName("");
      setDescription("");
      setDurationMinutes(30);
      setBufferBefore(0);
      setBufferAfter(0);
      setPrice(0);
      setCurrency("INR");
      setIsActive(true);
    }
  }, [service, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || durationMinutes <= 0) {
      toast.error("Please provide a valid service name and duration");
      return;
    }

    setSubmitting(true);
    try {
      const url = service
        ? `/api/appointments/services/${service.id}`
        : "/api/appointments/services";
      const method = service ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          duration_minutes: durationMinutes,
          buffer_before_minutes: bufferBefore,
          buffer_after_minutes: bufferAfter,
          price,
          currency,
          is_active: isActive,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save service");
      }

      toast.success(service ? "Service updated" : "Service created");
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error saving service";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{service ? "Edit Service" : "Add New Service"}</DialogTitle>
          <DialogDescription>
            Configure appointment duration, pricing, and buffer times.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="service-name">Service Name *</Label>
            <Input
              id="service-name"
              placeholder="e.g. Dental Cleaning, Implant Consultation"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="service-desc">Description</Label>
            <Textarea
              id="service-desc"
              placeholder="Brief description of the service..."
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="service-duration">Duration (min) *</Label>
              <Input
                id="service-duration"
                type="number"
                min={5}
                step={5}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(parseInt(e.target.value, 10) || 15)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="buffer-before">Buffer Before (m)</Label>
              <Input
                id="buffer-before"
                type="number"
                min={0}
                step={5}
                value={bufferBefore}
                onChange={(e) => setBufferBefore(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="buffer-after">Buffer After (m)</Label>
              <Input
                id="buffer-after"
                type="number"
                min={0}
                step={5}
                value={bufferAfter}
                onChange={(e) => setBufferAfter(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="service-price">Price</Label>
              <Input
                id="service-price"
                type="number"
                min={0}
                step={1}
                value={price}
                onChange={(e) => setPrice(parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-currency">Currency</Label>
              <Input
                id="service-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="service-active" className="text-sm font-medium">Active & Bookable</Label>
              <p className="text-xs text-muted-foreground">Customers can see and book this service</p>
            </div>
            <Switch
              id="service-active"
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
                "Save Service"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
