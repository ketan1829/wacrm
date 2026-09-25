"use client";

import { useState, useMemo } from "react";
import {
  format,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  addDays,
  addWeeks,
  addMonths,
  subDays,
  subWeeks,
  subMonths,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Clock,
  User,
  Filter,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  Appointment,
  AppointmentStaff,
  AppointmentService,
  AppointmentStatus,
} from "@/lib/appointments/types";

export type CalendarViewMode = "day" | "week" | "month";

interface CalendarProps {
  appointments: Appointment[];
  staffList: AppointmentStaff[];
  servicesList: AppointmentService[];
  currentDate: Date;
  onDateChange: (date: Date) => void;
  viewMode: CalendarViewMode;
  onViewModeChange: (mode: CalendarViewMode) => void;
  onSelectAppointment: (appointment: Appointment) => void;
  onNewBookingClick: (prefilledDate?: string) => void;
}

export function Calendar({
  appointments,
  staffList,
  servicesList,
  currentDate,
  onDateChange,
  viewMode,
  onViewModeChange,
  onSelectAppointment,
  onNewBookingClick,
}: CalendarProps) {
  const [selectedStaffFilter, setSelectedStaffFilter] = useState<string>("all");
  const [selectedServiceFilter, setSelectedServiceFilter] = useState<string>("all");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("all");

  // Filter appointments
  const filteredAppointments = useMemo(() => {
    return appointments.filter((app) => {
      if (selectedStaffFilter !== "all" && app.staff_id !== selectedStaffFilter) {
        return false;
      }
      if (selectedServiceFilter !== "all" && app.service_id !== selectedServiceFilter) {
        return false;
      }
      if (selectedStatusFilter !== "all" && app.status !== selectedStatusFilter) {
        return false;
      }
      return true;
    });
  }, [appointments, selectedStaffFilter, selectedServiceFilter, selectedStatusFilter]);

  // Navigation handlers
  const handlePrev = () => {
    if (viewMode === "day") onDateChange(subDays(currentDate, 1));
    else if (viewMode === "week") onDateChange(subWeeks(currentDate, 1));
    else onDateChange(subMonths(currentDate, 1));
  };

  const handleNext = () => {
    if (viewMode === "day") onDateChange(addDays(currentDate, 1));
    else if (viewMode === "week") onDateChange(addWeeks(currentDate, 1));
    else onDateChange(addMonths(currentDate, 1));
  };

  const handleToday = () => {
    onDateChange(new Date());
  };

  // Header Title
  const periodTitle = useMemo(() => {
    if (viewMode === "day") {
      return format(currentDate, "EEEE, d MMMM yyyy");
    }
    if (viewMode === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "d MMM")} – ${format(end, "d MMM yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  }, [currentDate, viewMode]);

  // Days for Week view
  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    const end = endOfWeek(currentDate, { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [currentDate]);

  // Days for Month view
  const monthDays = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
    const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: startDate, end: endDate });
  }, [currentDate]);

  // Hours for Day view (08:00 to 20:00)
  const hours = Array.from({ length: 13 }, (_, i) => i + 8);

  return (
    <div className="space-y-4">
      {/* Calendar Controls & Filters Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-card border rounded-lg p-3">
        {/* Navigation & Title */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleToday}>
            Today
          </Button>
          <div className="flex items-center">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handlePrev}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <span className="font-semibold text-sm sm:text-base text-foreground pl-1">
            {periodTitle}
          </span>
        </div>

        {/* Filters and View Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Staff Filter */}
          <Select value={selectedStaffFilter} onValueChange={(v) => v && setSelectedStaffFilter(v)}>
            <SelectTrigger className="h-8 text-xs w-32 sm:w-36">
              <SelectValue placeholder="All Staff" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Staff</SelectItem>
              {staffList.map((st) => (
                <SelectItem key={st.id} value={st.id}>
                  {st.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Service Filter */}
          <Select value={selectedServiceFilter} onValueChange={(v) => v && setSelectedServiceFilter(v)}>
            <SelectTrigger className="h-8 text-xs w-32 sm:w-36">
              <SelectValue placeholder="All Services" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Services</SelectItem>
              {servicesList.map((srv) => (
                <SelectItem key={srv.id} value={srv.id}>
                  {srv.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Status Filter */}
          <Select value={selectedStatusFilter} onValueChange={(v) => v && setSelectedStatusFilter(v)}>
            <SelectTrigger className="h-8 text-xs w-28">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="no_show">No-Show</SelectItem>
            </SelectContent>
          </Select>

          {/* View Mode Switcher */}
          <div className="flex items-center rounded-md border bg-muted p-0.5 ml-auto sm:ml-0">
            <Button
              variant={viewMode === "day" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => onViewModeChange("day")}
            >
              Day
            </Button>
            <Button
              variant={viewMode === "week" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => onViewModeChange("week")}
            >
              Week
            </Button>
            <Button
              variant={viewMode === "month" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 text-xs px-2.5"
              onClick={() => onViewModeChange("month")}
            >
              Month
            </Button>
          </div>
        </div>
      </div>

      {/* ================= DAY VIEW ================= */}
      {viewMode === "day" && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="divide-y">
            {hours.map((hour) => {
              const hourDate = new Date(currentDate);
              hourDate.setHours(hour, 0, 0, 0);
              const hourLabel = format(hourDate, "hh:00 a");

              const hourAppointments = filteredAppointments.filter((app) => {
                const appDate = new Date(app.start_at);
                return isSameDay(appDate, currentDate) && appDate.getHours() === hour;
              });

              return (
                <div key={hour} className="flex min-h-[72px] group hover:bg-muted/20 transition-colors">
                  <div className="w-20 sm:w-24 p-2.5 text-xs text-muted-foreground border-r font-mono flex items-start justify-end pr-3 select-none">
                    {hourLabel}
                  </div>
                  <div className="flex-1 p-2 flex flex-wrap gap-2 items-center">
                    {hourAppointments.map((app) => (
                      <button
                        key={app.id}
                        type="button"
                        onClick={() => onSelectAppointment(app)}
                        className="text-left rounded-md border p-2 text-xs transition-all hover:shadow-sm hover:scale-[1.01] flex items-center gap-3 bg-background border-l-4"
                        style={{ borderLeftColor: app.staff?.color || "#3b82f6" }}
                      >
                        <div>
                          <div className="font-semibold text-foreground flex items-center gap-1.5">
                            <span>{app.customer_name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              ({format(new Date(app.start_at), "hh:mm a")} -{" "}
                              {format(new Date(app.end_at), "hh:mm a")})
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                            <span>{app.service?.name}</span>
                            <span>•</span>
                            <span className="font-medium">{app.staff?.name}</span>
                          </div>
                        </div>
                        <Badge
                          variant="outline"
                          className="ml-auto text-[10px] capitalize font-normal"
                        >
                          {app.status}
                        </Badge>
                      </button>
                    ))}

                    {hourAppointments.length === 0 && (
                      <button
                        type="button"
                        onClick={() => onNewBookingClick(format(currentDate, "yyyy-MM-dd"))}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-primary flex items-center gap-1 py-1 px-2 rounded hover:bg-muted"
                      >
                        <Plus className="h-3 w-3" />
                        Book at {hourLabel}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ================= WEEK VIEW ================= */}
      {viewMode === "week" && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <div className="min-w-[800px]">
            {/* Week Header */}
            <div className="grid grid-cols-7 border-b bg-muted/40 divide-x text-center text-xs font-medium py-2.5">
              {weekDays.map((day) => {
                const isToday = isSameDay(day, new Date());
                const isCurrent = isSameDay(day, currentDate);
                return (
                  <div key={day.toISOString()} className="px-1">
                    <div className="text-muted-foreground">{format(day, "EEE")}</div>
                    <div
                      className={`text-sm font-semibold inline-flex h-7 w-7 items-center justify-center rounded-full mt-0.5 ${
                        isToday
                          ? "bg-primary text-primary-foreground"
                          : isCurrent
                            ? "bg-muted text-foreground"
                            : "text-foreground"
                      }`}
                    >
                      {format(day, "d")}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Week Columns */}
            <div className="grid grid-cols-7 divide-x min-h-[460px]">
              {weekDays.map((day) => {
                const dayApps = filteredAppointments.filter((app) =>
                  isSameDay(new Date(app.start_at), day),
                );

                return (
                  <div
                    key={day.toISOString()}
                    className="p-1.5 space-y-1.5 hover:bg-muted/10 transition-colors flex flex-col"
                  >
                    {dayApps.map((app) => (
                      <button
                        key={app.id}
                        type="button"
                        onClick={() => onSelectAppointment(app)}
                        className="w-full text-left rounded border p-1.5 text-xs transition-transform hover:scale-[1.02] bg-background border-l-4 shadow-xs"
                        style={{ borderLeftColor: app.staff?.color || "#3b82f6" }}
                      >
                        <div className="font-medium text-foreground truncate">
                          {app.customer_name}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {format(new Date(app.start_at), "h:mm a")} • {app.service?.name}
                        </div>
                        <div className="text-[10px] text-muted-foreground/80 truncate">
                          {app.staff?.name}
                        </div>
                      </button>
                    ))}

                    <button
                      type="button"
                      onClick={() => onNewBookingClick(format(day, "yyyy-MM-dd"))}
                      className="mt-auto text-[11px] text-muted-foreground/50 hover:text-primary hover:bg-muted/40 p-1.5 rounded text-center transition-colors border border-dashed border-transparent hover:border-border"
                    >
                      + Book
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ================= MONTH VIEW ================= */}
      {viewMode === "month" && (
        <div className="rounded-lg border bg-card overflow-hidden">
          {/* Day Name Headers */}
          <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-xs font-semibold py-2">
            <div>Mon</div>
            <div>Tue</div>
            <div>Wed</div>
            <div>Thu</div>
            <div>Fri</div>
            <div>Sat</div>
            <div>Sun</div>
          </div>

          {/* Month Days Grid */}
          <div className="grid grid-cols-7 divide-x divide-y">
            {monthDays.map((day) => {
              const inCurrentMonth = isSameMonth(day, currentDate);
              const isToday = isSameDay(day, new Date());
              const dayApps = filteredAppointments.filter((app) =>
                isSameDay(new Date(app.start_at), day),
              );

              return (
                <div
                  key={day.toISOString()}
                  className={`min-h-[96px] p-1.5 flex flex-col transition-colors hover:bg-muted/20 ${
                    !inCurrentMonth ? "opacity-35 bg-muted/10" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-xs font-medium h-5 w-5 flex items-center justify-center rounded-full ${
                        isToday ? "bg-primary text-primary-foreground font-bold" : "text-muted-foreground"
                      }`}
                    >
                      {format(day, "d")}
                    </span>
                    {dayApps.length > 0 && (
                      <span className="text-[10px] text-muted-foreground font-medium">
                        {dayApps.length}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1 mt-1 flex-1 overflow-y-auto max-h-[70px]">
                    {dayApps.slice(0, 3).map((app) => (
                      <button
                        key={app.id}
                        type="button"
                        onClick={() => onSelectAppointment(app)}
                        className="w-full text-left truncate rounded px-1 py-0.5 text-[10px] font-medium border-l-2 bg-muted/40 hover:bg-muted block"
                        style={{ borderLeftColor: app.staff?.color || "#3b82f6" }}
                        title={`${app.customer_name} (${app.service?.name})`}
                      >
                        {format(new Date(app.start_at), "h:mm a")} {app.customer_name}
                      </button>
                    ))}
                    {dayApps.length > 3 && (
                      <span className="text-[10px] text-muted-foreground block text-center">
                        +{dayApps.length - 3} more
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
