// User-facing kernel API. Only the host's authenticated user handler imports this module (lint bans it in
// agents and web): it is the one place that produces the `UserConfirmed` brand for PlanApproved/LevelConfirmed.
import type { EventBody, KernelEvent } from "./kernel/events.ts";
import type { Iso } from "./kernel/types.ts";

/** Wraps a body as a user event; the cast applies the phantom `UserConfirmed` brand. */
export function userEvent(body: EventBody, at: Iso): KernelEvent {
	return { ...body, actor: "user", at } as KernelEvent;
}
