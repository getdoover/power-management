// ---------------------------------------------------------------------------
// Shared logic for parsing the `doover_connection` channel — aggregate +
// message history — into something both widgets can render.
//
// The aggregate's data shape (`status`, `determination`, `config`) lives in
// doover-js as `ConnectionAggregate`; we re-export it here so existing
// imports in this codebase keep resolving from the same place.
//
// History messages on this channel come in a few shapes depending on the
// writer (see `statusBlockOf` for the normalisation):
//   - a ping, *flat*:     { status: "ContinuousOnline", last_online, last_ping, ip?, user_agent?, latency_ms? }
//   - a ping, *wrapped*:  { status: { status, last_online, last_ping, ... }, determination?: "Online"|"Offline" }
//   - a config change:    { config: { connection_type, expected_interval, ... } }
// All timestamps are integer epoch milliseconds (doover-data convention).
// ---------------------------------------------------------------------------

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

import type {
  ConnectionAggregate,
  ConnectionConfig,
  ConnectionDetermination,
  ConnectionStatusBlock,
  ConnectionStatusCode,
} from "doover-js";

dayjs.extend(relativeTime);

export type ConnState = "online" | "overdue" | "offline" | "unknown";

// Re-export the doover-js connection types so existing in-repo imports keep
// pointing at this module.
export type {
  ConnectionAggregate,
  ConnectionConfig,
  ConnectionDetermination,
  ConnectionStatusBlock,
  ConnectionStatusCode,
} from "doover-js";

export interface HistoryMessage {
  id?: string | number;
  timestamp?: number | string | null;
  // `doover_connection` messages come in a few shapes depending on the writer:
  //   - a ping, *flat*:     { status: "ContinuousOnline", last_online, last_ping, ip?, user_agent?, latency_ms? }
  //   - a ping, *wrapped*:  { status: { status, last_online, last_ping, ... }, determination?: "Online"|"Offline" }
  //   - a config change:    { config: { connection_type, expected_interval, ... } }
  // so we keep `data` loose and normalise in `statusBlockOf` / `determinationOf`.
  data?: Record<string, any> | null;
}

// ---------------------------------------------------------------------------
// Tuning — mirrors the platform's connection-sync rule (channels-rest
// `connection_sync.rs`): a device is "offline" once it's been silent for
// `offline_after`, defaulting to 120 s for Continuous links and 1 h otherwise.
// ---------------------------------------------------------------------------
const DEFAULT_CONTINUOUS_OFFLINE_AFTER_SEC = 120;
const DEFAULT_PERIODIC_OFFLINE_AFTER_SEC = 3600;
// a little slack on top of `offline_after` for the *current-state* badge so it
// doesn't flicker offline in the moment before the next 120 s aggregate update
const STATE_GRACE_MS = 30_000;
export const HISTORY_LIMIT = 1500; // messages endpoint's max per-call cap

export const WINDOWS: { key: string; label: string; days: number }[] = [
  { key: "1d", label: "24 hours", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
export function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/** Validate a positive epoch-ms value. doover-data timestamps are ms-ints throughout. */
export function toEpochMs(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function connectionTypeLabel(config: ConnectionConfig | null | undefined): string {
  switch (config?.connection_type) {
    case "Continuous":
      return "Continuous";
    case "PeriodicContinuous":
      return "Periodic (continuous)";
    case "Periodic":
      return "Periodic";
    default:
      return "Unknown";
  }
}

export function isPeriodic(config: ConnectionConfig | null | undefined): boolean {
  return config?.connection_type === "Periodic" || config?.connection_type === "PeriodicContinuous";
}

/** Just the always-connected-while-awake periodic mode (holds a websocket between sleeps). */
export function isPeriodicContinuous(config: ConnectionConfig | null | undefined): boolean {
  return config?.connection_type === "PeriodicContinuous";
}

// ---------------------------------------------------------------------------
// Aggregate / message parsing
// ---------------------------------------------------------------------------

/**
 * Pull the connection-status fields out of whatever shape a `doover_connection`
 * payload uses — either nested under `status` (the aggregate, and pydoover's
 * wrapped pings) or flattened at the top level (the device agent's pings, where
 * `status` is the enum string and `last_ping`/`last_online`/`ip`/… are siblings).
 * Returns null when the payload carries no status fields (e.g. a config change).
 */
function statusBlockOf(d: Record<string, any> | null | undefined): ConnectionStatusBlock | null {
  if (!d || typeof d !== "object") return null;
  if (d.status && typeof d.status === "object") return d.status as ConnectionStatusBlock;
  const hasFlat =
    typeof d.status === "string" || d.last_ping != null || d.last_online != null || d.latency_ms != null;
  if (!hasFlat) return null;
  return {
    // platform-supplied enum string — cast to the doover-js typed union; an
    // unrecognised value would still flow through as a string at runtime.
    status: typeof d.status === "string" ? (d.status as ConnectionStatusCode) : null,
    last_ping: num(d.last_ping),
    last_online: num(d.last_online),
    latency_ms: num(d.latency_ms),
    ip: typeof d.ip === "string" ? d.ip : null,
    user_agent: typeof d.user_agent === "string" ? d.user_agent : null,
  };
}

/** Best estimate of when we last heard from the device, in epoch ms. */
export function lastSeenMs(
  agg: ConnectionAggregate | null | undefined,
  aggregateLastUpdated?: number | null,
): number | null {
  const candidates = [
    toEpochMs(agg?.status?.last_ping),
    toEpochMs(agg?.status?.last_online),
    toEpochMs(aggregateLastUpdated),
  ].filter((v): v is number => v != null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Seconds of silence (since the last ping) after which the device is "offline".
 * Mirrors `channels-rest` `connection_sync.rs`: `offline_after` if set, else
 * 120 s for `Continuous`, else `expected_interval × 2` or 1 h. Used by
 * `buildSegments` to place the trailing offline transition on the timeline;
 * current-state classification defers to the aggregate's `determination`
 * instead and doesn't touch this.
 */
function offlineAfterMs(config: ConnectionConfig | null | undefined): number {
  const oa = num(config?.offline_after);
  if (oa != null) return oa * 1000;
  if (config?.connection_type === "Continuous") return DEFAULT_CONTINUOUS_OFFLINE_AFTER_SEC * 1000;
  const ei = num(config?.expected_interval);
  if (ei != null) return ei * 2 * 1000;
  return DEFAULT_PERIODIC_OFFLINE_AFTER_SEC * 1000;
}

/**
 * When we next *expect* to hear from the device, in epoch ms — `next_wake_time`
 * if it's set and in the future, otherwise last-seen + the expected interval.
 * Returns null if there's nothing useful to base it on.
 */
export function nextExpectedMs(
  lastSeen: number | null,
  config: ConnectionConfig | null | undefined,
): number | null {
  const wake = toEpochMs(config?.next_wake_time);
  if (wake != null) return wake;
  if (lastSeen == null) return null;
  const interval = num(config?.expected_interval);
  if (interval != null) return lastSeen + interval * 1000;
  return null;
}

/**
 * Classify the device's *current* connection state from the aggregate's
 * `determination` — single source of truth, set by doover-data
 * (`channels-rest` `connection_sync.rs`'s offline-after timer). On top of an
 * Online determination we layer an "overdue" UI state when the next expected
 * contact has already passed.
 *
 *  - unknown  — no `determination` on the aggregate (no aggregate at all,
 *               or device never seen)
 *  - offline  — `determination: "Offline"`
 *  - overdue  — Online but past `next_wake_time` / last-seen + `expected_interval`
 *  - online   — Online and within its schedule / grace
 */
export function classifyState(
  lastSeen: number | null,
  config: ConnectionConfig | null | undefined,
  now: number = Date.now(),
  determination?: ConnectionDetermination | null,
): ConnState {
  if (determination === "Offline") return "offline";
  if (determination === "Online") {
    if (lastSeen != null) {
      const dueMs = nextExpectedMs(lastSeen, config);
      if (dueMs != null && now > dueMs) return "overdue";
    }
    return "online";
  }
  return "unknown";
}

/** "Up" = currently connected. Overdue/offline are not up; "unknown" is neither. */
export function isUp(state: ConnState): boolean {
  return state === "online";
}

// ---------------------------------------------------------------------------
// History → timeline segments
// ---------------------------------------------------------------------------
export interface ConnSample {
  t: number; // epoch ms — when this ping/transition happened (prefers the status block's last_ping)
  msgT: number | null; // epoch ms the message itself was logged (snowflake / `.timestamp`), if known
  online: boolean; // determination at that moment
  latencyMs: number | null;
  /** the normalised status block that produced this sample (its `.status` is the raw enum code, e.g. "ContinuousPending"; null for a bare `{determination}` message) */
  status: ConnectionStatusBlock | null;
}

export interface ConfigSample {
  t: number;
  config: ConnectionConfig;
}

export interface ParsedHistory {
  samples: ConnSample[]; // determination samples, ascending by t
  configChanges: ConfigSample[]; // config-change events, ascending by t
}

/**
 * "Was the device online at this sample?" from a normalised status block.
 *  - `determination: "Online"/"Offline"` wins if present
 *  - else the `status` enum code: `…Online…` / `…Pending…` → up, `…Offline…` → down
 *  - else a bare ping (has last_ping/last_online) → up
 *  - else null (ambiguous: Unknown / PeriodicUnknown, or no status info)
 *
 * "Pending" counts as up — it's a live websocket awaiting its first confirmed
 * ping, not a disconnection.
 */
function onlineFrom(determination: string | null | undefined, sb: ConnectionStatusBlock | null): boolean | null {
  if (typeof determination === "string") return determination === "Online";
  const code = sb?.status;
  if (typeof code === "string") {
    if (code.includes("Offline")) return false;
    if (code.includes("Online") || code.includes("Pending")) return true;
    return null; // Unknown / PeriodicUnknown
  }
  if (sb && (sb.last_ping != null || sb.last_online != null)) return true;
  return null;
}

export function parseHistory(messages: HistoryMessage[] | null | undefined): ParsedHistory {
  const samples: ConnSample[] = [];
  const configChanges: ConfigSample[] = [];
  for (const m of messages ?? []) {
    const data = m?.data;
    if (!data || typeof data !== "object") continue;
    const msgT = toEpochMs(m.timestamp);
    const sb = statusBlockOf(data);
    const online = onlineFrom(typeof data.determination === "string" ? data.determination : null, sb);
    if (online != null) {
      // Prefer the snowflake-derived `msgT` (server-assigned at message create
      // time, always reliable) over `last_ping`/`last_online` from the device's
      // status block — those can be stale or malformed (we've seen tiny values
      // that put the sample near 1970, which then makes the per-device widget's
      // "online for" compute as decades). Fall back to the device-supplied
      // values only if msgT is missing.
      const t = msgT ?? toEpochMs(sb?.last_ping) ?? toEpochMs(sb?.last_online);
      if (t != null) samples.push({ t, msgT, online, latencyMs: num(sb?.latency_ms), status: sb });
    }
    if (data.config && typeof data.config === "object") {
      const t = msgT ?? toEpochMs(sb?.last_ping);
      if (t != null) configChanges.push({ t, config: data.config });
    }
  }
  samples.sort((a, b) => a.t - b.t);
  configChanges.sort((a, b) => a.t - b.t);
  return { samples, configChanges };
}

export interface Segment {
  startMs: number;
  endMs: number;
  state: ConnState; // "online" | "overdue" | "offline" | "unknown"
}

/**
 * Build a timeline of connection-state segments over [windowStartMs, nowMs].
 *
 * The `doover_connection` channel logs a message only when the connection
 * *status changes* (`ContinuousPending` → `ContinuousOnline` → `ContinuousOffline`
 * → …, plus a `{determination:"Offline"}` when the platform's offline timer
 * fires, and `{config:…}` changes) — the 120 s keepalives only update the
 * aggregate, not the channel. So each history sample is a *transition*; the
 * state between samples is the last sample's state. The trailing edge from the
 * last sample to `now` uses the live aggregate: if the aggregate's last-ping is
 * fresh the device is online now; if it's stale past `offline_after` it's
 * offline (the platform would log a `{determination:"Offline"}` once its sync
 * daemon runs — we anticipate it). Time before the channel's first message —
 * i.e. before the device existed — is `"unknown"`.
 */
export function buildSegments(
  samples: ConnSample[],
  windowStartMs: number,
  nowMs: number,
  currentState: ConnState,
  lastSeen: number | null,
  config: ConnectionConfig | null | undefined,
): Segment[] {
  const sorted = [...samples].filter((s) => s.t <= nowMs).sort((a, b) => a.t - b.t);
  const segs: Segment[] = [];

  if (sorted.length === 0) {
    // No transition messages at all. A device that's ever been online has a
    // `ContinuousOnline` message at its channel's start, which we'd have
    // fetched — so "no samples" really means we only know the live state.
    segs.push({ startMs: windowStartMs, endMs: nowMs, state: lastSeen != null ? currentState : "unknown" });
    return clipMerge(segs, windowStartMs, nowMs);
  }

  // If the oldest message we have is after the window start, the channel itself
  // started then (the device is younger than the window) → unknown before it.
  if (sorted[0].t > windowStartMs) {
    segs.push({ startMs: windowStartMs, endMs: sorted[0].t, state: "unknown" });
  }

  let curStart = sorted[0].t;
  let curUp = sorted[0].online;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.online !== curUp) {
      segs.push({ startMs: curStart, endMs: s.t, state: curUp ? "online" : "offline" });
      curStart = s.t;
      curUp = s.online;
    }
  }
  const lastT = sorted[sorted.length - 1].t;

  // Trailing edge: reconcile the last transition with the live aggregate.
  if (curUp) {
    if (currentState === "online") {
      segs.push({ startMs: curStart, endMs: nowMs, state: "online" }); // still up
    } else {
      // aggregate's last-ping has gone stale (or determination flipped) but no
      // "Offline" message yet — it goes offline once it's been silent for
      // `offline_after` past the last ping.
      const offlineAt = Math.min(Math.max((lastSeen ?? lastT) + offlineAfterMs(config), curStart), nowMs);
      if (offlineAt > curStart) segs.push({ startMs: curStart, endMs: offlineAt, state: "online" });
      segs.push({ startMs: offlineAt, endMs: nowMs, state: currentState }); // "offline" / "overdue"
    }
  } else if (currentState === "online" && lastSeen != null && lastSeen > lastT) {
    // last *message* was an Offline determination, but the device has pinged
    // since → it reconnected. We don't (yet) get a reconnect message with the
    // real reconnect time, so the offline period extends to the last ping.
    segs.push({ startMs: curStart, endMs: lastSeen, state: "offline" });
    segs.push({ startMs: lastSeen, endMs: nowMs, state: "online" });
  } else {
    segs.push({ startMs: curStart, endMs: nowMs, state: "offline" });
  }

  return clipMerge(segs, windowStartMs, nowMs);
}

/** Clip segments to [windowStartMs, nowMs], drop empties, merge adjacent same-state. */
function clipMerge(segs: Segment[], windowStartMs: number, nowMs: number): Segment[] {
  const clipped = segs
    .map((s) => ({ ...s, startMs: Math.max(s.startMs, windowStartMs), endMs: Math.min(s.endMs, nowMs) }))
    .filter((s) => s.endMs > s.startMs);
  const merged: Segment[] = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && last.state === s.state && Math.abs(last.endMs - s.startMs) < 1000) last.endMs = s.endMs;
    else merged.push({ ...s });
  }
  return merged;
}

export interface SleepSpan {
  startMs: number;
  endMs: number;
}

/**
 * "Sleeping" overlay spans for a `PeriodicContinuous` device — each stretch from
 * the connection dropping to `ContinuousPending` (the device let its websocket
 * go to sleep) up to the next `ContinuousOnline` / `…OnlineNoPing` (it woke and
 * reconnected). An in-between `ContinuousOffline` (it overran its wake) doesn't
 * end the span — it's still "asleep" until it actually checks in; a trailing
 * pending with nothing after runs to `now`. Returns `[]` for any other
 * connection type. Spans are clipped to `[windowStartMs, nowMs]`.
 *
 * Each boundary is taken from the message's *log time* (`msgT`) — i.e. when the
 * connection state was actually set — falling back to the sample time.
 */
export function buildSleepSegments(
  samples: ConnSample[],
  windowStartMs: number,
  nowMs: number,
  config: ConnectionConfig | null | undefined,
): SleepSpan[] {
  if (!isPeriodicContinuous(config)) return [];
  const sorted = [...samples].filter((s) => s.t <= nowMs).sort((a, b) => a.t - b.t);
  const spans: SleepSpan[] = [];
  let sleepStart: number | null = null;
  for (const s of sorted) {
    const code = s.status?.status ?? "";
    const at = s.msgT ?? s.t;
    if (code === "ContinuousPending") {
      if (sleepStart == null) sleepStart = at; // first pending of this sleep wins
    } else if (code.includes("Online") || (!code && s.online)) {
      if (sleepStart != null && at > sleepStart) spans.push({ startMs: sleepStart, endMs: at });
      sleepStart = null;
    }
  }
  if (sleepStart != null) spans.push({ startMs: sleepStart, endMs: nowMs });
  return spans
    .map((s) => ({ startMs: Math.max(s.startMs, windowStartMs), endMs: Math.min(s.endMs, nowMs) }))
    .filter((s) => s.endMs > s.startMs);
}

// ---------------------------------------------------------------------------
// History-strip segments — connection segments merged with sleep spans into
// a tri-state list (online / offline / sleeping) for the fleet table's
// uptime strip. Overdue collapses into offline for this view: the strip is
// a glanceable "where is the device asleep vs genuinely down", so the user
// only wants three colours.
// ---------------------------------------------------------------------------
export type HistoryStripState = "online" | "offline" | "sleeping" | "unknown";

export interface HistoryStripSegment {
  startMs: number;
  endMs: number;
  state: HistoryStripState;
}

/**
 * Overlay sleep spans onto the connection segments and emit one tri-state
 * timeline:
 *   - online (no sleep overlap)
 *   - sleeping (online ∩ sleep)
 *   - offline (offline or overdue — sleep doesn't override; a sleeping device
 *     that's also offline still reads as offline because the user is looking
 *     for "is anything wrong")
 *   - unknown (no data — left out of the strip render entirely)
 *
 * Sleep spans are only non-empty for `PeriodicContinuous` devices (see
 * `buildSleepSegments`), so for all other connection types this collapses
 * back to the original online/offline strip.
 */
export function buildHistoryStripSegments(
  segments: Segment[],
  sleepSegments: SleepSpan[],
  windowStartMs: number,
  nowMs: number,
): HistoryStripSegment[] {
  if (nowMs <= windowStartMs) return [];

  // Cut points: every segment + sleep boundary inside the window, plus the
  // window edges. Each adjacent pair becomes one strip slot whose state we
  // read off the underlying segment + sleep maps.
  const cuts = new Set<number>([windowStartMs, nowMs]);
  for (const s of segments) {
    if (s.endMs > windowStartMs && s.startMs < nowMs) {
      cuts.add(Math.max(s.startMs, windowStartMs));
      cuts.add(Math.min(s.endMs, nowMs));
    }
  }
  for (const sl of sleepSegments) {
    if (sl.endMs > windowStartMs && sl.startMs < nowMs) {
      cuts.add(Math.max(sl.startMs, windowStartMs));
      cuts.add(Math.min(sl.endMs, nowMs));
    }
  }
  const points = [...cuts].sort((a, b) => a - b);

  // Slot midpoints are monotonically increasing, and both `segments` and
  // `sleepSegments` are sorted by start time, so we walk all three in one
  // sweep with two cursors that only advance forward. O(slots + segs + sleeps)
  // instead of O(slots × (segs + sleeps)).
  const out: HistoryStripSegment[] = [];
  let segIdx = 0;
  let sleepIdx = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    const mid = (start + end) / 2;

    while (segIdx + 1 < segments.length && mid >= segments[segIdx].endMs) segIdx++;
    const base = segments[segIdx]?.state ?? "unknown";

    while (sleepIdx < sleepSegments.length && sleepSegments[sleepIdx].endMs <= mid) sleepIdx++;
    const sleeping =
      sleepIdx < sleepSegments.length &&
      mid >= sleepSegments[sleepIdx].startMs &&
      mid < sleepSegments[sleepIdx].endMs;

    let state: HistoryStripState;
    if (base === "offline" || base === "overdue") state = "offline";
    else if (base === "online") state = sleeping ? "sleeping" : "online";
    else state = "unknown";

    const last = out[out.length - 1];
    if (last && last.state === state && last.endMs === start) last.endMs = end;
    else out.push({ startMs: start, endMs: end, state });
  }
  return out;
}

/**
 * Fraction of the time we *have data for* that the device was connected
 * (online ÷ online + overdue + offline) — "unknown" stretches are excluded from
 * both, so this is "uptime over the period the connection channel covers".
 * `null` when there's no known coverage at all.
 */
export function uptimeFraction(segments: Segment[], windowStartMs: number, nowMs: number): number | null {
  let up = 0;
  let down = 0;
  for (const s of segments) {
    const lo = Math.max(s.startMs, windowStartMs);
    const hi = Math.min(s.endMs, nowMs);
    if (hi <= lo || s.state === "unknown") continue;
    if (isUp(s.state)) up += hi - lo;
    else down += hi - lo;
  }
  return up + down > 0 ? up / (up + down) : null;
}

/** Fraction of [windowStartMs, nowMs] we have no connection data for. */
export function unknownFraction(segments: Segment[], windowStartMs: number, nowMs: number): number {
  const span = nowMs - windowStartMs;
  if (span <= 0) return 0;
  let unk = 0;
  for (const s of segments) {
    if (s.state !== "unknown") continue;
    const lo = Math.max(s.startMs, windowStartMs);
    const hi = Math.min(s.endMs, nowMs);
    if (hi > lo) unk += hi - lo;
  }
  return Math.max(0, Math.min(1, unk / span));
}

// ---------------------------------------------------------------------------
// Series for charts
// ---------------------------------------------------------------------------
export interface TimelinePoint {
  t: number; // epoch ms
  up: number | null; // 1 = up, 0 = down, null = before any data
  latencyMs: number | null;
}

/** State of whichever segment contains `t` (boundaries belong to the segment that starts there; past the end → the last segment). */
function stateAt(segments: Segment[], t: number): ConnState {
  return segments.find((s, i) => t >= s.startMs && (t < s.endMs || i === segments.length - 1))?.state ?? "unknown";
}

/**
 * Step-series for the device chart: an `up` value (1/0) sampled at every
 * segment boundary (so a `stepAfter` area draws the on/off pattern), plus the
 * latency reading attached to whichever sample falls at-or-before each point,
 * plus a regular grid of baseline points across the window so the chart's hover
 * tooltip tracks the cursor everywhere — even over a long unbroken stretch (e.g.
 * a device that's online the whole time) that has no transitions of its own.
 */
export function timelineSeries(
  segments: Segment[],
  samples: ConnSample[],
  windowStartMs: number,
  nowMs: number,
): TimelinePoint[] {
  const latAt = (t: number): number | null => {
    // most recent sample at-or-before t that carried a latency reading
    let best: number | null = null;
    for (const s of samples) {
      if (s.t > t) break;
      if (s.latencyMs != null) best = s.latencyMs;
    }
    return best;
  };
  const upOf = (st: ConnState): number | null => (st === "unknown" ? null : isUp(st) ? 1 : 0);
  const pts: TimelinePoint[] = [];
  for (const seg of segments) {
    const up = upOf(seg.state);
    pts.push({ t: seg.startMs, up, latencyMs: up === 1 ? latAt(seg.startMs) : null });
    // a tick just before each transition keeps the step crisp (and lets the
    // latency line drop to null right at an offline edge)
    pts.push({ t: Math.max(seg.startMs, seg.endMs - 1), up, latencyMs: up === 1 ? latAt(seg.endMs - 1) : null });
  }
  const last = segments[segments.length - 1];
  pts.push({ t: nowMs, up: last ? upOf(last.state) : null, latencyMs: last && upOf(last.state) === 1 ? latAt(nowMs) : null });
  // baseline grid (latency left null — the latency line `connectNulls` over it)
  const STEPS = 120;
  if (nowMs > windowStartMs) {
    for (let i = 1; i < STEPS; i++) {
      const t = windowStartMs + (i * (nowMs - windowStartMs)) / STEPS;
      pts.push({ t, up: upOf(stateAt(segments, t)), latencyMs: null });
    }
  }
  // raw latency samples within online stretches, for resolution between edges
  for (const s of samples) {
    if (s.t < windowStartMs || s.t > nowMs || s.latencyMs == null) continue;
    pts.push({ t: s.t, up: 1, latencyMs: s.latencyMs });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

export function hasLatencyData(samples: ConnSample[]): boolean {
  return samples.some((s) => s.latencyMs != null);
}

export function avgLatencyMs(samples: ConnSample[]): number | null {
  const vals = samples.map((s) => s.latencyMs).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// Ping-frequency histogram (periodic devices)
//
// The `doover_connection` channel logs a message every time the device's
// connection state changes — for a `Periodic` link that's effectively
// once per check-in. Bucketing those by time gives a histogram of how
// often the device is actually contacting us, which is the headline
// diagnostic for a periodic device: "is it pinging on schedule?".
// ---------------------------------------------------------------------------
export interface PingBucket {
  /** Bucket centre, epoch ms — what the chart's XAxis ticks anchor against. */
  t: number;
  /** Inclusive-exclusive bucket span `[startMs, endMs)`, used by the tooltip to name the period. */
  startMs: number;
  endMs: number;
  /** How many transition messages fell into the bucket. */
  count: number;
}

/**
 * Histogram bucket width per window-selector preset: 1h bars over 24h, 1d
 * bars over 7d and 30d. Wider windows fall back to ~30 buckets.
 */
export function pingBucketMs(windowDays: number): number {
  if (windowDays <= 1) return 60 * 60_000; // 1 h
  if (windowDays <= 30) return 24 * 60 * 60_000; // 1 d
  return Math.max(60 * 60_000, Math.round((windowDays * 86_400_000) / 30));
}

/**
 * Bucket each sample in `[windowStartMs, nowMs]` into wall-clock-aligned slots
 * (top-of-hour for hour buckets, local midnight for day buckets) so the bars
 * label cleanly as e.g. "11:00–12:00" rather than "11:23–12:23 from now". The
 * first and last buckets are clipped to the window, so they may be partial.
 * Returns a row per slot (zero-bars included so the chart shows gaps).
 */
export function pingFrequency(
  samples: ConnSample[],
  windowStartMs: number,
  nowMs: number,
  bucketMs: number,
): PingBucket[] {
  if (nowMs <= windowStartMs || bucketMs <= 0) return [];
  const dayBuckets = bucketMs >= 24 * 60 * 60_000;
  const alignDown = (t: number): number =>
    dayBuckets ? dayjs(t).startOf("day").valueOf() : dayjs(t).startOf("hour").valueOf();
  // DST-safe step: dayjs.add(1, 'day') lands on the next local midnight even
  // across DST transitions; hour buckets are always exactly bucketMs apart.
  const stepForward = (start: number): number =>
    dayBuckets ? dayjs(start).add(1, "day").valueOf() : start + bucketMs;

  const buckets: PingBucket[] = [];
  let start = alignDown(windowStartMs);
  while (start < nowMs) {
    const next = stepForward(start);
    const clippedStart = Math.max(start, windowStartMs);
    const clippedEnd = Math.min(next, nowMs);
    if (clippedEnd > clippedStart) {
      buckets.push({
        t: Math.round((clippedStart + clippedEnd) / 2),
        startMs: clippedStart,
        endMs: clippedEnd,
        count: 0,
      });
    }
    start = next;
  }
  // Count samples per bucket. Linear scan keeps the helper independent of
  // sample order; the bucket count is small (≤30 for any selected window).
  for (const s of samples) {
    if (s.t < windowStartMs || s.t > nowMs) continue;
    for (let i = 0; i < buckets.length; i++) {
      if (s.t >= buckets[i].startMs && s.t < buckets[i].endMs) {
        buckets[i].count++;
        break;
      }
    }
  }
  return buckets;
}


// ---------------------------------------------------------------------------
// Fleet aggregation: "how many devices were online over time"
// ---------------------------------------------------------------------------
export interface FleetTimelinePoint {
  t: number;
  online: number; // devices up at this bucket
  total: number;
}

/**
 * Bucket each device's segments over [windowStartMs, nowMs] into `buckets`
 * equal slots and count, per slot, how many devices were *actually online*
 * (state === "online" or "overdue") for most of the slot. Devices we have no
 * data for (entirely "unknown" segments — e.g. the aggregate fetch was
 * unauthorised, or the device has never pinged) drop out of both the numerator
 * and the denominator: counting them as online would silently inflate the line.
 */
export function fleetOnlineOverTime(
  perDeviceSegments: Segment[][],
  windowStartMs: number,
  nowMs: number,
  buckets = 96,
): FleetTimelinePoint[] {
  const span = nowMs - windowStartMs;
  if (span <= 0 || perDeviceSegments.length === 0) return [];
  // exclude devices whose segments are *only* unknown (no aggregate data)
  const knownSegments = perDeviceSegments.filter((segs) => segs.some((s) => s.state !== "unknown"));
  const total = knownSegments.length;
  const slot = span / buckets;
  const out: FleetTimelinePoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const bStart = windowStartMs + i * slot;
    const bEnd = bStart + slot;
    let online = 0;
    for (const segs of knownSegments) {
      let upMs = 0;
      for (const s of segs) {
        if (s.state !== "online" && s.state !== "overdue") continue;
        const lo = Math.max(s.startMs, bStart);
        const hi = Math.min(s.endMs, bEnd);
        if (hi > lo) upMs += hi - lo;
      }
      if (upMs > slot / 2) online++;
    }
    out.push({ t: Math.round(bStart + slot / 2), online, total });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
export const STATE_LABEL: Record<ConnState, string> = {
  online: "Online",
  overdue: "Overdue",
  offline: "Offline",
  unknown: "Unknown",
};

/** An SVG-safe colour for a connection state (used in the recharts/SVG charts). */
export function stateColor(state: ConnState): string {
  switch (state) {
    case "online":
      return "#16a34a"; // green-600
    case "overdue":
      return "#d97706"; // amber-600
    case "offline":
      return "#dc2626"; // red-600
    default:
      return "#9ca3af"; // gray-400
  }
}

export const LATENCY_COLOR = "#2563eb"; // blue-600
export const SLEEP_COLOR = "#4499df"; // rgb(68,153,223) — the "asleep" overlay band on a PeriodicContinuous timeline

export function relTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return dayjs(ms).fromNow();
}

export function absTime(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return dayjs(ms).format("ddd D MMM, HH:mm");
}
