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


/** Which club the player is looking at. Each is a separate scope. */
let venue = 'solna';
export const setVenue = (v: string): void => {
  venue = v;
};
export const getVenue = (): string => venue;
/**
 * Signing in is a NAVIGATION, not a fetch: the browser leaves for the issuer and comes
 * back to `/api/auth/callback` with a session cookie. This app hosts no sign-up.
 */
export const auth = {
  login: (returnTo = '/') => location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
  logout: () => location.assign('/api/auth/logout'),
};

/**
 * Who the caller is AT THE SELECTED VENUE — the role hint, and their own member id.
 * `memberId` is null for staff and for a login with no member record here; both are
 * facts, not failures.
 */
export interface WhoAmI {
  role: 'club-admin' | 'receptionist' | 'coach' | 'player' | 'none';
  memberId: string | null;
}

export interface Venue {
  key: string;
  label: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
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

/**
 * Accept a club invitation — deliberately NOT through `call`, because the recipient is
 * by definition not yet a member of this club and `call`'s ordinary path assumes they
 * are. What proves the acceptance is the email in the caller's OWN verified token; the
 * body carries only the invitation id, so an acceptor cannot name the address they are
 * being checked against. It used to be able to: a fresh principal rode the dev header
 * and the identifier came from this request body.
 */
export async function acceptInvite(invitationId: string): Promise<{ state: string }> {
  const res = await fetch('/api/invites/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-venue': venue },
    body: JSON.stringify({ invitationId }),
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
  /** Who am I at this venue, and which member am I here. */
  whoami: (): Promise<WhoAmI> => call('/api/whoami'),
  /** Which clubs THIS login can actually act in — resolved per venue, server-side. */
  myVenues: (): Promise<Venue[]> => call('/api/my-venues'),
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
