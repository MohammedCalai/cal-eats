export type ScheduleMode = "asap" | "scheduled";
export type ScheduleChoice = { mode: ScheduleMode; scheduledFor: string | null };

export function initialScheduleChoice(value: ScheduleChoice | null | undefined, acceptingOrders: boolean): ScheduleChoice {
  if (value?.mode === "scheduled") {
    const target = typeof value.scheduledFor === "string" && Number.isFinite(Date.parse(value.scheduledFor)) ? new Date(value.scheduledFor).toISOString() : null;
    return { mode: "scheduled", scheduledFor: target };
  }
  return { mode: acceptingOrders ? "asap" : "scheduled", scheduledFor: null };
}

export function reconcileScheduleChoice(choice: ScheduleChoice, availableTimes: readonly string[], locked = false): ScheduleChoice {
  if (locked || choice.mode !== "scheduled" || !choice.scheduledFor || availableTimes.includes(choice.scheduledFor)) return choice;
  // A removed/expired time requires an explicit replacement. Preserve the
  // customer's intent to order later instead of falling back to an ASAP order.
  return { mode: "scheduled", scheduledFor: null };
}
