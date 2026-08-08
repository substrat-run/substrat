export interface CastMember {
  name: string;
  role: string;
  principal: string;
}
export interface Money {
  amount: string;
  currency: string;
}
export type Cover = 'indoor' | 'covered' | 'open';
export const COVER_SV: Record<Cover, string> = {
  indoor: 'Inomhus',
  covered: 'Tak',
  open: 'Utomhus',
};
export interface CourtListing {
  id: string;
  name: string;
  durations: string;
  cover: Cover;
}
/** A start time at the VENUE — offered if any court can take it (spec §4.2). */
export interface VenueSlot {
  startsAt: string;
  fits: number[];
  courts: { id: string; name: string; cover: Cover; fits: number[] }[];
}
export interface RosterEntry {
  partyRef: string;
  name: string;
  level: string | null;
  share: Money | null;
}
export interface Club {
  key: string;
  label: string;
  slug: string;
}
export interface PlayedWith {
  name: string;
  level: string | null;
  times: number;
  lastPlayed: string;
}
export interface SlotFit {
  startsAt: string;
  maxFitMinutes: number;
  fits: number[];
}
export type ReservationState =
  | 'held'
  | 'confirmed'
  | 'in_service'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'no_show';
export interface Reservation {
  id: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  state: ReservationState;
  effectiveState: ReservationState;
  expiresAt: string | null;
  fillTarget: number | null;
  note: string | null;
}
export interface VenueSnapshot {
  venue: { name: string; timezone: string; hold_minutes: number };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
  get isSlotTaken(): boolean {
    return this.code === 'SLOT_UNAVAILABLE';
  }
}

let principal = '';
export const setPrincipal = (p: string): void => {
  principal = p;
};

/** Which club the player is looking at. Each is a separate scope. */
let venue = 'solna';
export const setVenue = (v: string): void => {
  venue = v;
};
export const getVenue = (): string => venue;
export interface Venue {
  key: string;
  label: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // /api/cast is the only route that legitimately runs unauthenticated — it is
  // how the picker learns who it may be. Anything else firing without a
  // principal is a mount-ordering bug, and should say so rather than surface as
  // a mystery 403 from the server.
  if (!principal && path !== '/api/cast') {
    throw new ApiError(0, `no principal selected yet — ${path} fired before the picker was ready`);
  }
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(principal ? { 'x-principal': principal } : {}),
      'x-venue': venue,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as T;
}
const post = <T,>(p: string, b?: unknown): Promise<T> =>
  call<T>(p, { method: 'POST', body: JSON.stringify(b ?? {}) });

/** ULID-shaped principal for a newcomer (Crockford: no I L O U). */
function newPrincipal(): string {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  for (let i = 0; i < 26; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

/**
 * Accept a club invitation — deliberately NOT through `call`: the recipient is
 * by definition not yet a member, so there is no persona to send and no
 * principal-guard to satisfy. A fresh principal rides the dev header; with a
 * real session the server ignores it and uses the session's own identity and
 * verified email instead.
 */
export async function acceptInvite(
  invitationId: string,
  identifier: string,
): Promise<{ state: string }> {
  const res = await fetch('/api/invites/accept', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-principal': newPrincipal(),
      'x-venue': venue,
    },
    body: JSON.stringify({ invitationId, identifier }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as { state: string };
}

export interface OpenMatch {
  reservationId: string;
  resourceId: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  joined: number;
  fillTarget: number;
  levelMin: string;
  levelMax: string;
  share: Money;
  players: RosterEntry[];
  /** Present only when searching across clubs. */
  venue?: string;
  venueLabel?: string;
}

export interface MatchLanding {
  status: 'open' | 'full' | 'expired' | 'gone';
  reservationId: string;
  courtName: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
  joined: number;
  fillTarget: number;
  levelMin: string;
  levelMax: string;
  share: Money;
  players: RosterEntry[];
  venue?: string;
  venueLabel?: string;
}

export const api = {
  openMatches: (allClubs = false): Promise<OpenMatch[]> =>
    call(allClubs ? '/api/matches?all=1' : '/api/matches'),
  clubs: (): Promise<Club[]> => call('/api/clubs'),
  playedWith: (memberId: string): Promise<PlayedWith[]> =>
    call(`/api/played-with?memberId=${memberId}`),
  quote: (
    date: string, time: string, duration: number, cover: Cover[] = [],
  ): Promise<{ price: Money; label: string; courts: { id: string; name: string; cover: Cover }[] }> =>
    call(
      `/api/quote?date=${date}&time=${time}&duration=${duration}` +
        (cover.length ? `&cover=${cover.join(',')}` : ''),
    ),
  venueAvailability: (date: string, cover: Cover[] = []): Promise<VenueSlot[]> =>
    call(`/api/venue-availability?date=${date}${cover.length ? `&cover=${cover.join(',')}` : ''}`),
  match: (id: string): Promise<MatchLanding | null> => call(`/api/matches/${id}`),
  createMatch: (i: {
    resourceId?: string;
    cover?: Cover[];
    memberId: string;
    date: string;
    time: string;
    duration: number;
    fillTarget: number;
    levelMin: string;
    levelMax: string;
  }): Promise<{ reservation: Reservation; price: Money; sharePerPlayer: Money }> =>
    post('/api/matches', i),
  joinMatch: (id: string, memberId: string): Promise<{ share: Money }> =>
    post(`/api/matches/${id}/join`, { memberId }),
  cast: (): Promise<{
    cast: Record<string, CastMember>;
    venues: Venue[];
    members: Record<string, Record<string, string>>;
  }> => call('/api/cast'),
  venue: (): Promise<VenueSnapshot> => call('/api/venue'),
  courts: (): Promise<CourtListing[]> => call('/api/browse/courts'),
  availability: (resourceId: string, date: string): Promise<SlotFit[]> =>
    call(`/api/availability?resourceId=${resourceId}&date=${date}`),
  myBookings: (): Promise<Reservation[]> => call('/api/portal/bookings'),
  book: (i: {
    resourceId?: string;
    cover?: Cover[];
    memberId: string;
    date: string;
    time: string;
    duration: number;
  }): Promise<{ reservation: Reservation; price: Money; ruleLabel: string }> =>
    post('/api/bookings', i),
  confirm: (id: string): Promise<{ reservation: Reservation; price: Money }> =>
    post(`/api/bookings/${id}/confirm`),
  cancel: (id: string): Promise<Reservation> => post(`/api/bookings/${id}/cancel`, {}),
};

export function hhmm(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(instant));
}
export function dayLabel(instant: string, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(instant));
}
