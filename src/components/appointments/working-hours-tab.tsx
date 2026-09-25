"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Clock, Calendar as CalendarIcon, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type {
  AppointmentStaff,
  AppointmentAvailability,
  AppointmentAvailabilityException,
} from "@/lib/appointments/types";

const DAYS_OF_WEEK = [
  { day: 1, name: "Monday" },
  { day: 2, name: "Tuesday" },
  { day: 3, name: "Wednesday" },
  { day: 4, name: "Thursday" },
  { day: 5, name: "Friday" },
  { day: 6, name: "Saturday" },
  { day: 0, name: "Sunday" },
];

interface IntervalItem {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

interface WorkingHoursTabProps {
  staffList: AppointmentStaff[];
}

export function WorkingHoursTab({ staffList }: WorkingHoursTabProps) {
  const [selectedStaffId, setSelectedStaffId] = useState<string>("");
  const [intervals, setIntervals] = useState<IntervalItem[]>([]);
  const [exceptions, setExceptions] = useState<AppointmentAvailabilityException[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // New exception form state
  const [newExcDate, setNewExcDate] = useState("");
  const [newExcReason, setNewExcReason] = useState("");
  const [newExcUnavailable, setNewExcUnavailable] = useState(true);
  const [newExcStart, setNewExcStart] = useState("09:00");
  const [newExcEnd, setNewExcEnd] = useState("13:00");
  const [addingExc, setAddingExc] = useState(false);

  useEffect(() => {
    if (staffList.length > 0 && !selectedStaffId) {
      setSelectedStaffId(staffList[0].id);
    }
  }, [staffList, selectedStaffId]);

  const fetchHoursAndExceptions = useCallback(async () => {
    if (!selectedStaffId) return;
    setLoading(true);
    try {
      const [hoursRes, excRes] = await Promise.all([
        fetch(`/api/appointments/working-hours?staff_id=${selectedStaffId}`),
        fetch(`/api/appointments/exceptions?staff_id=${selectedStaffId}`),
      ]);
      const hoursData = await hoursRes.json();
      const excData = await excRes.json();

      if (hoursData.hours) {
        setIntervals(
          hoursData.hours.map((h: AppointmentAvailability) => ({
            day_of_week: h.day_of_week,
            start_time: h.start_time.slice(0, 5),
            end_time: h.end_time.slice(0, 5),
          })),
        );
      }
      if (excData.exceptions) {
        setExceptions(excData.exceptions);
      }
    } catch (e) {
      console.error("Failed to load working hours:", e);
    } finally {
      setLoading(false);
    }
  }, [selectedStaffId]);

  useEffect(() => {
    fetchHoursAndExceptions();
  }, [fetchHoursAndExceptions]);

  const addInterval = (day: number) => {
    setIntervals((prev) => [
      ...prev,
      { day_of_week: day, start_time: "09:00", end_time: "17:00" },
    ]);
  };

  const removeInterval = (index: number) => {
    setIntervals((prev) => prev.filter((_, i) => i !== index));
  };

  const updateInterval = (
    index: number,
    field: "start_time" | "end_time",
    val: string,
  ) => {
    setIntervals((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item)),
    );
  };

  const handleSaveHours = async () => {
    if (!selectedStaffId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/appointments/working-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staff_id: selectedStaffId,
          intervals: intervals.map((i) => ({
            ...i,
            start_time: `${i.start_time}:00`,
            end_time: `${i.end_time}:00`,
          })),
        }),
      });
      if (!res.ok) throw new Error("Failed to save working hours");
      toast.success("Working hours saved successfully!");
    } catch {
      toast.error("Error saving working hours");
    } finally {
      setSaving(false);
    }
  };

  const handleAddException = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newExcDate) {
      toast.error("Please select a date");
      return;
    }

    setAddingExc(true);
    try {
      const res = await fetch("/api/appointments/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staff_id: selectedStaffId,
          exception_date: newExcDate,
          is_unavailable: newExcUnavailable,
          start_time: newExcUnavailable ? null : `${newExcStart}:00`,
          end_time: newExcUnavailable ? null : `${newExcEnd}:00`,
          reason: newExcReason.trim() || null,
        }),
      });

      if (!res.ok) throw new Error("Failed to add exception");

      toast.success("Schedule exception added");
      setNewExcDate("");
      setNewExcReason("");
      fetchHoursAndExceptions();
    } catch {
      toast.error("Failed to add exception");
    } finally {
      setAddingExc(false);
    }
  };

  const handleDeleteException = async (id: string) => {
    try {
      const res = await fetch(`/api/appointments/exceptions/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove exception");
      toast.success("Exception removed");
      setExceptions((prev) => prev.filter((e) => e.id !== id));
    } catch {
      toast.error("Failed to remove exception");
    }
  };

  const selectedStaff = staffList.find((s) => s.id === selectedStaffId);

  return (
    <div className="space-y-6">
      {/* Staff Selector Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <h3 className="font-semibold text-foreground">Select Provider</h3>
          <p className="text-xs text-muted-foreground">
            Configure working hours and break intervals per staff member.
          </p>
        </div>
        <div className="w-full sm:w-64">
          <Select value={selectedStaffId} onValueChange={(v) => v && setSelectedStaffId(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select staff provider" />
            </SelectTrigger>
            <SelectContent>
              {staffList.map((st) => (
                <SelectItem key={st.id} value={st.id}>
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: st.color }}
                    />
                    <span>{st.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex justify-center items-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          Loading schedule...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Weekly Working Hours (2 cols) */}
          <div className="lg:col-span-2 rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h4 className="font-semibold text-foreground">
                  Weekly Schedule for {selectedStaff?.name || "Provider"}
                </h4>
                <p className="text-xs text-muted-foreground">
                  Add multiple intervals per day to configure lunch breaks or split shifts.
                </p>
              </div>
              <Button size="sm" onClick={handleSaveHours} disabled={saving} className="gap-1.5">
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save Schedule"}
              </Button>
            </div>

            <div className="divide-y space-y-3">
              {DAYS_OF_WEEK.map(({ day, name }) => {
                const dayIntervals = intervals
                  .map((item, idx) => ({ ...item, originalIndex: idx }))
                  .filter((item) => item.day_of_week === day);

                return (
                  <div key={day} className="pt-3 first:pt-0">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium text-sm text-foreground w-28">
                        {name}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-primary"
                        onClick={() => addInterval(day)}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Add interval
                      </Button>
                    </div>

                    {dayIntervals.length === 0 ? (
                      <span className="text-xs text-muted-foreground italic pl-2">
                        Day Off (Unavailable)
                      </span>
                    ) : (
                      <div className="space-y-2 pl-2">
                        {dayIntervals.map((int) => (
                          <div
                            key={int.originalIndex}
                            className="flex items-center gap-2 text-sm"
                          >
                            <Input
                              type="time"
                              className="w-32 h-8 text-xs"
                              value={int.start_time}
                              onChange={(e) =>
                                updateInterval(
                                  int.originalIndex,
                                  "start_time",
                                  e.target.value,
                                )
                              }
                            />
                            <span className="text-muted-foreground text-xs">to</span>
                            <Input
                              type="time"
                              className="w-32 h-8 text-xs"
                              value={int.end_time}
                              onChange={(e) =>
                                updateInterval(
                                  int.originalIndex,
                                  "end_time",
                                  e.target.value,
                                )
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                              onClick={() => removeInterval(int.originalIndex)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Exceptions & Holidays (1 col) */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div>
              <h4 className="font-semibold text-foreground">Holidays & Exceptions</h4>
              <p className="text-xs text-muted-foreground">
                Block vacations, national holidays, or override hours for a specific date.
              </p>
            </div>

            {/* Add Exception Form */}
            <form onSubmit={handleAddException} className="space-y-3 rounded-md border p-3 bg-muted/20">
              <div className="space-y-1">
                <Label className="text-xs">Exception Date *</Label>
                <Input
                  type="date"
                  className="h-8 text-xs"
                  value={newExcDate}
                  onChange={(e) => setNewExcDate(e.target.value)}
                  required
                />
              </div>

              <div className="flex items-center justify-between py-1">
                <Label className="text-xs">Full Day Off</Label>
                <Switch
                  checked={newExcUnavailable}
                  onCheckedChange={setNewExcUnavailable}
                />
              </div>

              {!newExcUnavailable && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Start Time</Label>
                    <Input
                      type="time"
                      className="h-8 text-xs"
                      value={newExcStart}
                      onChange={(e) => setNewExcStart(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">End Time</Label>
                    <Input
                      type="time"
                      className="h-8 text-xs"
                      value={newExcEnd}
                      onChange={(e) => setNewExcEnd(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <Label className="text-xs">Reason (optional)</Label>
                <Input
                  placeholder="e.g. Festival, Doctor Vacation"
                  className="h-8 text-xs"
                  value={newExcReason}
                  onChange={(e) => setNewExcReason(e.target.value)}
                />
              </div>

              <Button type="submit" size="sm" className="w-full h-8 text-xs" disabled={addingExc}>
                {addingExc ? "Adding..." : "Add Exception"}
              </Button>
            </form>

            {/* Exceptions List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {exceptions.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No exceptions configured.
                </p>
              ) : (
                exceptions.map((exc) => (
                  <div
                    key={exc.id}
                    className="flex items-center justify-between rounded border p-2 text-xs bg-card"
                  >
                    <div>
                      <div className="font-medium text-foreground">
                        {exc.exception_date}
                      </div>
                      <div className="text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        {exc.is_unavailable ? (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 border-red-500/30 text-red-500">
                            Off
                          </Badge>
                        ) : (
                          <span>
                            {exc.start_time?.slice(0, 5)} - {exc.end_time?.slice(0, 5)}
                          </span>
                        )}
                        {exc.reason && <span>• {exc.reason}</span>}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                      onClick={() => handleDeleteException(exc.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
