"use client";

import { useState, useEffect, useCallback } from "react";
import { format, isSameDay } from "date-fns";
import {
  Calendar as CalendarIcon,
  Plus,
  Users,
  Briefcase,
  Clock,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Calendar, type CalendarViewMode } from "@/components/appointments/calendar";
import { AppointmentDrawer } from "@/components/appointments/appointment-drawer";
import { AppointmentBookingModal } from "@/components/appointments/appointment-booking-modal";
import { ServiceDialog } from "@/components/appointments/service-dialog";
import { StaffDialog } from "@/components/appointments/staff-dialog";
import { WorkingHoursTab } from "@/components/appointments/working-hours-tab";
import { formatCurrency } from "@/lib/currency";
import type {
  Appointment,
  AppointmentService,
  AppointmentStaff,
} from "@/lib/appointments/types";

export default function AppointmentsPage() {
  const [activeTab, setActiveTab] = useState<string>("calendar");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [staff, setStaff] = useState<AppointmentStaff[]>([]);
  const [loading, setLoading] = useState(true);

  // Calendar State
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Modals
  const [bookingModalOpen, setBookingModalOpen] = useState(false);
  const [bookingPrefillDate, setBookingPrefillDate] = useState<string | undefined>();
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<AppointmentService | null>(null);
  const [staffDialogOpen, setStaffDialogOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<AppointmentStaff | null>(null);

  // Fetch all appointments, services, and staff
  const loadData = useCallback(async () => {
    try {
      const [appRes, srvRes, stfRes] = await Promise.all([
        fetch("/api/appointments"),
        fetch("/api/appointments/services"),
        fetch("/api/appointments/staff"),
      ]);

      const appData = await appRes.json();
      const srvData = await srvRes.json();
      const stfData = await stfRes.json();

      if (appData.appointments) setAppointments(appData.appointments);
      if (srvData.services) setServices(srvData.services);
      if (stfData.staff) setStaff(stfData.staff);
    } catch (err) {
      console.error("Failed to load appointments data:", err);
      toast.error("Failed to load appointments");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Appointment Drawer handler
  const handleSelectAppointment = (app: Appointment) => {
    setSelectedAppointment(app);
    setDrawerOpen(true);
  };

  const handleOpenBooking = (prefillDate?: string) => {
    setBookingPrefillDate(prefillDate);
    setBookingModalOpen(true);
  };

  // Metrics summary
  const todayApps = appointments.filter((a) =>
    isSameDay(new Date(a.start_at), new Date()),
  );
  const confirmedCount = appointments.filter((a) => a.status === "confirmed").length;
  const pendingCount = appointments.filter((a) => a.status === "pending").length;
  const completedCount = appointments.filter((a) => a.status === "completed").length;
  const cancelledCount = appointments.filter((a) => a.status === "cancelled").length;
  const noShowCount = appointments.filter((a) => a.status === "no_show").length;

  // Toggle active service
  const handleToggleService = async (service: AppointmentService) => {
    try {
      const res = await fetch(`/api/appointments/services/${service.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !service.is_active }),
      });
      if (!res.ok) throw new Error("Failed to update service");
      setServices((prev) =>
        prev.map((s) => (s.id === service.id ? { ...s, is_active: !s.is_active } : s)),
      );
      toast.success("Service status updated");
    } catch {
      toast.error("Failed to update service status");
    }
  };

  // Toggle active staff
  const handleToggleStaff = async (staffMember: AppointmentStaff) => {
    try {
      const res = await fetch(`/api/appointments/staff/${staffMember.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !staffMember.is_active }),
      });
      if (!res.ok) throw new Error("Failed to update staff");
      setStaff((prev) =>
        prev.map((s) => (s.id === staffMember.id ? { ...s, is_active: !s.is_active } : s)),
      );
      toast.success("Provider status updated");
    } catch {
      toast.error("Failed to update provider status");
    }
  };

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Loading appointments...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <CalendarIcon className="h-6 w-6 text-primary" />
            Appointments & Calendar
          </h1>
          <p className="text-sm text-muted-foreground">
            Schedule, manage, and automate appointments booked directly through WhatsApp.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => handleOpenBooking()} className="gap-2 shadow-sm">
            <Plus className="h-4 w-4" />
            New booking
          </Button>
        </div>
      </div>

      {/* Stats Summary Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded-lg border bg-card p-3 shadow-2xs">
          <span className="text-xs text-muted-foreground">Today</span>
          <div className="text-xl font-bold text-foreground mt-0.5">{todayApps.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-3 shadow-2xs">
          <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Confirmed</span>
          <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">{confirmedCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-3 shadow-2xs">
          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Pending</span>
          <div className="text-xl font-bold text-amber-600 dark:text-amber-400 mt-0.5">{pendingCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-3 shadow-2xs">
          <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Completed</span>
          <div className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-0.5">{completedCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-3 shadow-2xs">
          <span className="text-xs text-red-600 dark:text-red-400 font-medium">Cancelled</span>
          <div className="text-xl font-bold text-red-600 dark:text-red-400 mt-0.5">{cancelledCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-3 shadow-2xs">
          <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">No-Show</span>
          <div className="text-xl font-bold text-purple-600 dark:text-purple-400 mt-0.5">{noShowCount}</div>
        </div>
      </div>

      {/* Main Tabs Container */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="bg-muted p-1">
          <TabsTrigger value="calendar" className="gap-1.5 text-xs sm:text-sm">
            <CalendarIcon className="h-4 w-4" />
            Calendar
          </TabsTrigger>
          <TabsTrigger value="services" className="gap-1.5 text-xs sm:text-sm">
            <Briefcase className="h-4 w-4" />
            Services ({services.length})
          </TabsTrigger>
          <TabsTrigger value="staff" className="gap-1.5 text-xs sm:text-sm">
            <Users className="h-4 w-4" />
            Staff ({staff.length})
          </TabsTrigger>
          <TabsTrigger value="availability" className="gap-1.5 text-xs sm:text-sm">
            <Clock className="h-4 w-4" />
            Working Hours
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Visual Calendar */}
        <TabsContent value="calendar" className="space-y-4">
          <Calendar
            appointments={appointments}
            staffList={staff}
            servicesList={services}
            currentDate={currentDate}
            onDateChange={setCurrentDate}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onSelectAppointment={handleSelectAppointment}
            onNewBookingClick={handleOpenBooking}
          />
        </TabsContent>

        {/* Tab 2: Services Management */}
        <TabsContent value="services" className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground">Services</h3>
              <p className="text-xs text-muted-foreground">
                Define the procedures or consultations clients can book through WhatsApp or calendar.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditingService(null);
                setServiceDialogOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add Service
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {services.map((srv) => (
              <div
                key={srv.id}
                className="rounded-lg border bg-card p-4 space-y-3 hover:border-primary/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="font-semibold text-foreground">{srv.name}</h4>
                    {srv.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {srv.description}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={srv.is_active}
                    onCheckedChange={() => handleToggleService(srv)}
                    title={srv.is_active ? "Active" : "Inactive"}
                  />
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
                  <span className="flex items-center gap-1 font-medium text-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {srv.duration_minutes} mins
                  </span>
                  <span>•</span>
                  <span>
                    Buffers: {srv.buffer_before_minutes}m / {srv.buffer_after_minutes}m
                  </span>
                </div>

                <div className="flex items-center justify-between pt-2 border-t text-xs">
                  <span className="font-semibold text-sm text-foreground">
                    {formatCurrency(srv.price, srv.currency)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setEditingService(srv);
                      setServiceDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* Tab 3: Staff Management */}
        <TabsContent value="staff" className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-foreground">Staff & Providers</h3>
              <p className="text-xs text-muted-foreground">
                Manage doctors, specialists, and hygienists who provide services.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditingStaff(null);
                setStaffDialogOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add Provider
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {staff.map((st) => (
              <div
                key={st.id}
                className="rounded-lg border bg-card p-4 space-y-3 hover:border-primary/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="h-3.5 w-3.5 rounded-full inline-block shrink-0 shadow-2xs"
                      style={{ backgroundColor: st.color }}
                    />
                    <div>
                      <h4 className="font-semibold text-foreground">{st.name}</h4>
                      {st.phone && (
                        <p className="text-xs text-muted-foreground">{st.phone}</p>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={st.is_active}
                    onCheckedChange={() => handleToggleStaff(st)}
                    title={st.is_active ? "Active" : "Inactive"}
                  />
                </div>

                {st.email && (
                  <p className="text-xs text-muted-foreground truncate">{st.email}</p>
                )}

                <div className="space-y-1 pt-1">
                  <span className="text-[11px] font-medium text-muted-foreground block">
                    Services Assigned:
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {(st.service_ids || []).length === 0 ? (
                      <span className="text-xs text-muted-foreground italic">
                        All services
                      </span>
                    ) : (
                      (st.service_ids || []).map((srvId) => {
                        const srv = services.find((s) => s.id === srvId);
                        return (
                          <Badge
                            key={srvId}
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0"
                          >
                            {srv?.name || "Service"}
                          </Badge>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-end pt-2 border-t text-xs">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setEditingStaff(st);
                      setStaffDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* Tab 4: Working Hours & Exceptions */}
        <TabsContent value="availability" className="space-y-4">
          <WorkingHoursTab staffList={staff} />
        </TabsContent>
      </Tabs>

      {/* Appointment Drawer */}
      <AppointmentDrawer
        appointment={selectedAppointment}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onUpdated={loadData}
      />

      {/* New Booking Modal */}
      <AppointmentBookingModal
        open={bookingModalOpen}
        onOpenChange={setBookingModalOpen}
        onBooked={loadData}
        preselectedDate={bookingPrefillDate}
      />

      {/* Service Dialog */}
      <ServiceDialog
        open={serviceDialogOpen}
        onOpenChange={setServiceDialogOpen}
        service={editingService}
        onSaved={loadData}
      />

      {/* Staff Dialog */}
      <StaffDialog
        open={staffDialogOpen}
        onOpenChange={setStaffDialogOpen}
        staff={editingStaff}
        services={services}
        onSaved={loadData}
      />
    </div>
  );
}
