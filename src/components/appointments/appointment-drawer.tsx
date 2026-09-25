"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Calendar,
  Clock,
  User,
  Phone,
  MessageSquare,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Copy,
  Check,
  Tag,
  DollarSign,
  FileText,
  Trash2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/currency";
import type { Appointment, AppointmentStatus } from "@/lib/appointments/types";

interface AppointmentDrawerProps {
  appointment: Appointment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

const STATUS_VARIANTS: Record<
  AppointmentStatus,
  { label: string; className: string }
> = {
  confirmed: {
    label: "Confirmed",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  pending: {
    label: "Pending",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  completed: {
    label: "Completed",
    className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  cancelled: {
    label: "Cancelled",
    className: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  },
  no_show: {
    label: "No-Show",
    className: "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400",
  },
  rescheduled: {
    label: "Rescheduled",
    className: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
};

export function AppointmentDrawer({
  appointment,
  open,
  onOpenChange,
  onUpdated,
}: AppointmentDrawerProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  if (!appointment) return null;

  const startDate = new Date(appointment.start_at);
  const endDate = new Date(appointment.end_at);
  const dateFormatted = format(startDate, "EEEE, d MMMM yyyy");
  const timeFormatted = `${format(startDate, "hh:mm a")} – ${format(endDate, "hh:mm a")}`;

  const copyPhone = async () => {
    await navigator.clipboard.writeText(appointment.customer_phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleUpdateStatus = async (status: AppointmentStatus) => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/appointments/${appointment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      toast.success(`Appointment marked as ${status}`);
      onUpdated();
    } catch {
      toast.error("Failed to update appointment");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`/api/appointments/${appointment.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason }),
      });
      if (!res.ok) throw new Error("Failed to cancel");
      toast.success("Appointment cancelled");
      setCancelModalOpen(false);
      onUpdated();
    } catch {
      toast.error("Failed to cancel appointment");
    } finally {
      setActionLoading(false);
    }
  };

  const openConversation = () => {
    onOpenChange(false);
    if (appointment.conversation_id) {
      router.push(`/inbox?conversationId=${appointment.conversation_id}`);
    } else {
      router.push(`/inbox`);
    }
  };

  const statusMeta = STATUS_VARIANTS[appointment.status] || STATUS_VARIANTS.confirmed;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="pb-4 border-b">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline" className={statusMeta.className}>
                {statusMeta.label}
              </Badge>
              <span className="text-xs text-muted-foreground capitalize">
                Source: {appointment.source.replace("_", " ")}
              </span>
            </div>
            <SheetTitle className="text-xl font-bold mt-2">
              {appointment.service?.name || "Appointment"}
            </SheetTitle>
            <SheetDescription>
              Appointment details and management
            </SheetDescription>
          </SheetHeader>

          <div className="py-4 space-y-6">
            {/* Customer Information */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Customer Details
              </h4>
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-medium">
                  {appointment.customer_name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="font-medium text-foreground">
                    {appointment.customer_name}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5" />
                    <span>{appointment.customer_phone}</span>
                    <button
                      type="button"
                      onClick={copyPhone}
                      className="hover:text-foreground transition-colors"
                      title="Copy phone"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Open Conversation Button - Critical CRM link */}
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2 gap-2 text-primary border-primary/20 hover:bg-primary/5"
                onClick={openConversation}
              >
                <MessageSquare className="h-4 w-4" />
                Open WhatsApp Conversation
              </Button>
            </div>

            {/* Appointment Schedule & Provider */}
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Schedule & Provider
              </h4>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2.5 text-foreground">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span>{dateFormatted}</span>
                </div>
                <div className="flex items-center gap-2.5 text-foreground">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span>{timeFormatted}</span>
                  <span className="text-xs text-muted-foreground">
                    ({appointment.service?.duration_minutes || 30} mins)
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-foreground pt-1">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full inline-block"
                      style={{ backgroundColor: appointment.staff?.color || "#3b82f6" }}
                    />
                    <span className="font-medium">
                      {appointment.staff?.name || "Assigned Provider"}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Service & Price */}
            <div className="rounded-lg border bg-card p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Service:</span>
                <span className="font-medium">{appointment.service?.name}</span>
              </div>
              {appointment.service?.price !== undefined && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Fee:</span>
                  <span className="font-semibold text-foreground">
                    {formatCurrency(appointment.service.price, appointment.service.currency || "INR")}
                  </span>
                </div>
              )}
              {appointment.notes && (
                <div className="pt-2 border-t mt-2">
                  <span className="text-xs text-muted-foreground block mb-1">Notes:</span>
                  <p className="text-sm bg-muted/40 p-2 rounded text-muted-foreground whitespace-pre-wrap">
                    {appointment.notes}
                  </p>
                </div>
              )}
              {appointment.cancellation_reason && (
                <div className="pt-2 border-t mt-2 text-red-600 dark:text-red-400">
                  <span className="text-xs font-semibold block mb-0.5">Cancellation Reason:</span>
                  <p className="text-sm">{appointment.cancellation_reason}</p>
                </div>
              )}
            </div>

            {/* Lifecycle Action Buttons */}
            {appointment.status !== "cancelled" && appointment.status !== "completed" && (
              <div className="space-y-2 pt-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Update Outcome
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/10"
                    disabled={actionLoading}
                    onClick={() => handleUpdateStatus("completed")}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Completed
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-purple-600 border-purple-500/30 hover:bg-purple-500/10"
                    disabled={actionLoading}
                    onClick={() => handleUpdateStatus("no_show")}
                  >
                    <AlertCircle className="h-4 w-4" />
                    No-Show
                  </Button>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full gap-1.5"
                    disabled={actionLoading}
                    onClick={() => setCancelModalOpen(true)}
                  >
                    <XCircle className="h-4 w-4" />
                    Cancel Appointment
                  </Button>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelModalOpen} onOpenChange={setCancelModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Appointment</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this appointment for {appointment.customer_name}?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="cancel-reason">Reason for cancellation (optional)</Label>
            <Textarea
              id="cancel-reason"
              placeholder="e.g. Patient requested, schedule conflict, emergency..."
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelModalOpen(false)}
              disabled={actionLoading}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={actionLoading}
            >
              {actionLoading ? "Cancelling..." : "Confirm Cancellation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
