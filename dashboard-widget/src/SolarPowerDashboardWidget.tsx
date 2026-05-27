import "./styles.css";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import {
  useAgentChannel,
  useDeviceMap,
  useDooverClient,
  useMultiAgentAggregates,
  useMultiAgentChannelMessages,
  type DeviceMapEntry,
} from "doover-js/react";
import { extractSnowflakeId, generateSnowflakeIdAtTime } from "doover-js";
import { useQuery } from "@tanstack/react-query";

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import localizedFormat from "dayjs/plugin/localizedFormat";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AlertTriangle,
  Battery,
  BatteryLow,
  BatteryWarning,
  ExternalLink,
  Info,
  Maximize2,
  Moon,
  Plug,
  Search,
  Sun,
  TriangleAlert,
  Unplug,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import { cn } from "./components/ui/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  classifyState,
  lastSeenMs as computeLastSeenMs,
  nextExpectedMs,
  toEpochMs as connToEpochMs,
  type ConnectionAggregate,
  type ConnState,
} from "./lib/connection";

dayjs.extend(relativeTime);
dayjs.extend(localizedFormat);

// ---------------------------------------------------------------------------
// Tuning constants — all heuristic. The Solar Power Management app publishes a
// kalman-filtered `system_voltage`, an `is_online` flag, `charge_state` /
// `charge_current` (Victron), `low_battery_warning_sent`, etc. under its app
// key; it also publishes a `doover_connection` aggregate with the periodic
// connection config (expected_interval / offline_after / next_wake_time).
// Connection-state classification (online / overdue / offline) is delegated to
// `./lib/connection`, which mirrors the platform's `connection_sync.rs` rule.
// ---------------------------------------------------------------------------
const FLEET_HISTORY_DAYS = 7; // dashboard list: a single 7-day batch window — one read covers the whole fleet (the batch messages endpoint caps the window at 7 days)
const DETAIL_HISTORY_DAYS = 30; // detail dialog: per-device getTimeseries accepts a >7-day window when BOTH bounds are given
const HISTORY_LIMIT = 1499; // cap on points per timeseries call (API requires < 1500)
const DETAIL_MAX_PAGES = 4; // page forward (advancing `after`) for chatty devices that hit the 1499 cap
const FLEET_AGENT_MSG_LIMIT = 500; // per-agent message cap in the batched fleet fetch
const DEFAULT_AT_RISK_HORIZON_DAYS = 30; // projected-to-flat within this window → "at risk"; overridable per device type / dashboard config
const MIN_TREND_SPAN_HOURS = 1; // need at least this much spread before we'll draw a trend
const MIN_PROJECT_SPAN_HOURS = 18; // ...and at least this much before we'll project to a cutoff off the raw slope
const FLAT_SLOPE_V_PER_DAY = 0.02; // |slope| below this is treated as "stable"
const DEFAULT_DORMANT_AFTER_DAYS = 30; // offline for at least this long → "dormant" instead of "offline"
// A "charge day" is one whose peak rises at least CHARGE_RISE_V above that day's
// low (or CHARGE_RISE_FRAC of it), OR whose peak reaches the rail's float band
// (`band.floatV`). The rise test catches the normal daytime solar swing; the
// float test catches batteries held up near full without a big daily dip. The
// absolute rise floor keeps the rule rail-agnostic — a healthy 24 V site's
// ~24→26 V daily swing is a smaller fraction than a 12 V site's ~12→14 V swing,
// so a flat percentage mis-flagged 24 V devices. No charge day for
// NOT_CHARGING_MIN_DAYS running → "not charging".
const CHARGE_RISE_V = 1.0;
const CHARGE_RISE_FRAC = 0.05;
const NOT_CHARGING_MIN_DAYS = 3;
const DAY_MS = 86_400_000;

// Per-rail battery voltage bands. 24 V systems are detected by voltage > 17.
// `floatV` is the lead-acid float setpoint — a peak at/above it means the
// charger is actively holding the battery up (matches typical 13.6 V / 27.2 V).
const BANDS = {
  v12: { low: 12.0, critical: 11.4, cutoff: 11.0, floatV: 13.6, plausibleMin: 5, plausibleMax: 17 },
  v24: { low: 24.0, critical: 22.8, cutoff: 22.0, floatV: 27.2, plausibleMin: 17, plausibleMax: 34 },
};

const BAD_CHARGE_STATES = ["fault", "error"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface UiRemoteComponentSolar {
  app_key: string; // the dashboard app's own key — DEVICE_MAP lives under it
}

type Severity = "ok" | "watch" | "atRisk" | "offline" | "dormant";
type HistoryStatus = "ok" | "loading" | "error" | "none" | "short";

/**
 * Narrowed `DeviceMapEntry` for this dashboard. The platform populates each
 * entry's `type.config.battery_voltage_tag` from the device type's JSON config
 * — a dotted path into `tag_values` such as
 * ``"solar_power_management_1.system_voltage"``. The widget reads voltage
 * (and the surrounding PM tag subtree) using that path; nothing about the
 * Solar Power Management app key is hardcoded in the widget anymore.
 *
 * `type.config.flat_battery_horizon_days` (optional) lets a device type tune
 * how soon a projected flat battery counts as "nearly offline" — e.g. a Doovit
 * that recharges over ~3 days wants a much tighter window than a solar site.
 */
interface SolarDeviceEntry extends DeviceMapEntry {
  type?: {
    id?: string | number | null;
    name?: string | null;
    config?: {
      battery_voltage_tag?: string | null;
      flat_battery_horizon_days?: number | null;
    } | null;
  } | null;
  // `solution_installs` is inherited from DeviceMapEntry (each carries a
  // `display_name`) — used for the solution filter.
}

/** Per-device `tag_values` aggregate shape: `{ <app_key>: { <tag_name>: value } }`. */
type TagValuesAggregate = Record<string, Record<string, unknown> | undefined>;

/**
 * Shape of the bits of `deployment_config` we care about — the dashboard
 * app's own block, where its configured options (dormant_after_days,
 * flat_battery_horizon_days, ignored_groups) live alongside the
 * platform-injected `DEVICE_MAP`.
 */
interface DashboardDeploymentConfig {
  applications?: Record<
    string,
    {
      dormant_after_days?: number | null;
      /** Fleet-wide fallback for the flat-battery projection horizon (days),
       *  used when a device type doesn't declare its own. */
      flat_battery_horizon_days?: number | string | null;
      /** Group ids (as strings, per pydoover's `GroupsConfig` schema) whose
       *  devices should be hidden from the dashboard entirely. The runtime
       *  key is `ignored_groups` (pydoover sanitises "Ignored Groups" into
       *  the schema key). */
      ignored_groups?: string[] | null;
    } & Record<string, unknown>
  >;
}

interface TrendInfo {
  slopePerDay: number; // V/day, least-squares fit through the raw history (negative = draining)
  dailyMinSlopePerDay: number | null; // V/day fit through per-day minima (robust to daytime charging spikes); null = <2 days
  latestV: number; // most recent voltage point
  latestDailyMin: number; // most recent daily-minimum voltage (the projection's starting point)
  dailyMins: { t: number; v: number }[]; // per-day minimum, timestamp at midday of that day, ascending
  nPoints: number; // raw history points the fit is based on
  firstMs: number; // timestamp of the oldest history point
  lastMs: number; // timestamp of the newest history point
  points: { t: number; v: number }[]; // raw history points (downsampled for charts), ascending
  spanHours: number; // time span of the available history
  projectedHoursToCutoff: number | null; // null = stable / rising / not enough history to project
  projectionBasis: "daily-min" | "raw" | null;
}

interface ChargingDay {
  d: number; // UTC day index (floor(t / DAY_MS))
  min: number;
  max: number;
  charged: boolean; // peak rose ≥CHARGE_RISE_V/≥CHARGE_RISE_FRAC above the low, or reached the float band
}

interface ChargingInfo {
  days: ChargingDay[]; // ascending, data-bearing days only
  consecutiveNotCharged: number; // trailing run of completed days without a charge cycle
  notCharging: boolean; // run >= NOT_CHARGING_MIN_DAYS and the data is current
  lastChargedDay: number | null;
}

interface DeviceRow {
  id: string;
  name: string;
  displayName: string;
  deviceTypeName: string | null;
  /** `solution_installs[].display_name`, deduped — empty if the device has none. */
  solutionNames: string[];
  /** Dotted path declared by the device type, e.g. ``"solar_power_management_1.system_voltage"``. Null when the type isn't configured. */
  voltagePath: string | null;
  /** First segment of `voltagePath` — the PM app key on this device (e.g. ``"solar_power_management_1"``). */
  pmKey: string | null;
  voltage: number | null;
  temperature: number | null;
  chargeState: string | null;
  chargeCurrent: number | null;
  lastSeenMs: number | null;
  conn: ConnectionAggregate["config"] | null;
  connState: ConnState;
  is24v: boolean;
  band: typeof BANDS.v12;
  trend: TrendInfo | null;
  charging: ChargingInfo | null;
  /** "Nearly offline" projection horizon for this device, in hours (per device type, else dashboard default). */
  atRiskHorizonHours: number;
  historyStatus: HistoryStatus;
  historyPointCount: number;
  issues: string[];
  severity: Severity;
  /** ascending sort key — smaller = more urgent */
  urgencyHours: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

/** Like `num`, but also coerces numeric strings — config values (e.g. a device
 *  type's `flat_battery_horizon_days`) sometimes arrive as strings like "7". */
function numLoose(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** Best human-readable name for a device entry: display_name → name → id. */
function displayNameOf(entry: SolarDeviceEntry): string {
  if (typeof entry.display_name === "string" && entry.display_name) return entry.display_name;
  if (typeof entry.name === "string" && entry.name) return entry.name;
  return entry.id;
}

/**
 * Walk a dotted path (``app_key.tag_name``, deeper for nested tag objects)
 * through an object — returns the leaf if it exists, or null otherwise.
 */
function resolveDotted(obj: unknown, path: string | null | undefined): unknown {
  if (!obj || !path) return null;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur ?? null;
}

/** Walk `path` through `obj` and return the leaf as a finite number, or null. */
function resolveDottedNumber(obj: unknown, path: string | null | undefined): number | null {
  const leaf = resolveDotted(obj, path);
  if (leaf == null) return null;
  return num(typeof leaf === "string" ? Number(leaf) : leaf);
}

/**
 * Pull the voltage value out of a single timeseries entry. The endpoint can
 * return either the scalar leaf directly (when called with a single dotted
 * field_name) or a nested object — we cover both, walking the device's
 * declared dotted path as a fallback.
 */
function extractVoltageFromSeriesValue(value: unknown, voltagePath: string): number | null {
  const direct = num(value);
  if (direct != null) return direct;
  // Try walking the full path from the top
  const viaPath = resolveDottedNumber(value, voltagePath);
  if (viaPath != null) return viaPath;
  // Or under the path's last segment alone (some shapes flatten to the leaf key)
  const segs = voltagePath.split(".");
  const leafKey = segs[segs.length - 1];
  if (value && typeof value === "object") {
    const leaf = (value as Record<string, unknown>)[leafKey];
    const n = num(leaf);
    if (n != null) return n;
    // Also try the field_name key as-is (some responses key by the dotted string)
    const flat = (value as Record<string, unknown>)[voltagePath];
    const nf = num(flat);
    if (nf != null) return nf;
  }
  return null;
}

/** Least-squares slope of y on x. Returns null if undefined (n < 2 or zero variance). */
function linFitSlope(pts: { x: number; y: number }[]): number | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

function downsampleEvenly<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}

/**
 * Build a trend from raw (timestamp, voltage) history. The headline slope is a
 * straight least-squares fit through the raw points; the *projection* prefers a
 * fit through the daily-minimum voltage (robust to daytime solar-charging
 * spikes) when ≥2 days of data are available, otherwise falls back to the raw
 * slope once there's a decent stretch of history.
 */
function computeTrend(points: { t: number; v: number }[], cutoff: number): TrendInfo | null {
  if (points.length < 3) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const spanHours = (sorted[sorted.length - 1].t - sorted[0].t) / 3_600_000;
  if (spanHours < MIN_TREND_SPAN_HOURS) return null;
  const latestV = sorted[sorted.length - 1].v;

  const t0 = sorted[0].t;
  const slopePerHour = linFitSlope(sorted.map((p) => ({ x: (p.t - t0) / 3_600_000, y: p.v })));
  if (slopePerHour == null) return null;
  const slopePerDay = slopePerHour * 24;

  // Daily minima — the robust basis for the projection.
  const byDay = new Map<number, number>();
  for (const p of sorted) {
    const d = Math.floor(p.t / DAY_MS);
    const cur = byDay.get(d);
    if (cur === undefined || p.v < cur) byDay.set(d, p.v);
  }
  const dayMins = [...byDay.entries()].map(([d, v]) => ({ d, v })).sort((a, b) => a.d - b.d);
  const dailyMins = dayMins.map((e) => ({ t: e.d * DAY_MS + DAY_MS / 2, v: e.v }));

  let dailyMinSlopePerDay: number | null = null;
  if (dayMins.length >= 2 && dayMins[dayMins.length - 1].d - dayMins[0].d >= 1) {
    dailyMinSlopePerDay = linFitSlope(dayMins.map((x) => ({ x: x.d, y: x.v })));
  }

  let projectedHoursToCutoff: number | null = null;
  let projectionBasis: "daily-min" | "raw" | null = null;
  if (dailyMinSlopePerDay != null && dailyMinSlopePerDay < -FLAT_SLOPE_V_PER_DAY) {
    const latestMin = dayMins[dayMins.length - 1].v;
    projectedHoursToCutoff = latestMin > cutoff ? Math.max(0, ((latestMin - cutoff) / -dailyMinSlopePerDay) * 24) : 0;
    projectionBasis = "daily-min";
  } else if (dailyMinSlopePerDay == null && spanHours >= MIN_PROJECT_SPAN_HOURS && slopePerDay < -FLAT_SLOPE_V_PER_DAY) {
    projectedHoursToCutoff = latestV > cutoff ? Math.max(0, ((latestV - cutoff) / -slopePerDay) * 24) : 0;
    projectionBasis = "raw";
  }

  return {
    slopePerDay,
    dailyMinSlopePerDay,
    latestV,
    latestDailyMin: dayMins[dayMins.length - 1].v,
    dailyMins,
    nPoints: sorted.length,
    firstMs: sorted[0].t,
    lastMs: sorted[sorted.length - 1].t,
    points: downsampleEvenly(sorted, 120),
    spanHours,
    projectedHoursToCutoff,
    projectionBasis,
  };
}

/**
 * Classify charging health from the voltage history. For each calendar day we
 * take that day's min and max; a "charge day" is one whose peak rose ≥1 V (or
 * ≥5%) above its low — the expected daytime solar swing — or reached the rail's
 * float band. A device is "not charging" once NOT_CHARGING_MIN_DAYS *completed*
 * days in a row show neither.
 *
 * The current (partial) day is treated as neutral while it hasn't charged yet —
 * a device that simply hasn't hit its afternoon peak shouldn't be flagged — and
 * the whole determination only stands if the most recent data is current
 * (today/yesterday), so stale histories from offline devices don't trip it.
 */
function computeCharging(points: { t: number; v: number }[], now: number, band: typeof BANDS.v12): ChargingInfo | null {
  if (points.length === 0) return null;
  const byDay = new Map<number, { min: number; max: number }>();
  for (const p of points) {
    const d = Math.floor(p.t / DAY_MS);
    const cur = byDay.get(d);
    if (!cur) byDay.set(d, { min: p.v, max: p.v });
    else {
      if (p.v < cur.min) cur.min = p.v;
      if (p.v > cur.max) cur.max = p.v;
    }
  }
  const days: ChargingDay[] = [...byDay.entries()]
    .map(([d, mm]) => ({
      d,
      min: mm.min,
      max: mm.max,
      charged:
        mm.max - mm.min >= CHARGE_RISE_V ||
        (mm.min > 0 && mm.max - mm.min >= mm.min * CHARGE_RISE_FRAC) ||
        mm.max >= band.floatV,
    }))
    .sort((a, b) => a.d - b.d);

  const todayIdx = Math.floor(now / DAY_MS);
  let consecutiveNotCharged = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    // skip the in-progress current day if it hasn't charged yet — neutral, not a failure
    if (days[i].d === todayIdx && !days[i].charged) continue;
    if (days[i].charged) break;
    consecutiveNotCharged++;
  }
  let lastChargedDay: number | null = null;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].charged) {
      lastChargedDay = days[i].d;
      break;
    }
  }
  const latestDay = days[days.length - 1].d;
  const recent = todayIdx - latestDay <= 1; // most recent data is today or yesterday
  const notCharging = recent && consecutiveNotCharged >= NOT_CHARGING_MIN_DAYS;
  return { days, consecutiveNotCharged, notCharging, lastChargedDay };
}

// ---------------------------------------------------------------------------
// History fetching
// ---------------------------------------------------------------------------
type VoltagePoint = { t: number; v: number };

/**
 * Per-device voltage history for the detail dialog, over `days`. Unlike the
 * batch messages endpoint (capped at a 7-day window), single-agent getTimeseries
 * accepts a wider window when BOTH bounds are given — results come oldest-first
 * capped at `limit`, so we page forward by advancing `after` for chatty devices.
 */
async function fetchDeviceVoltageHistory(
  client: ReturnType<typeof useDooverClient>,
  agentId: string,
  voltagePath: string,
  days: number,
): Promise<VoltagePoint[]> {
  const out: VoltagePoint[] = [];
  const before = generateSnowflakeIdAtTime(dayjs().add(2, "minute"));
  const cutoffMs = dayjs().subtract(days, "day").valueOf();
  let after = generateSnowflakeIdAtTime(dayjs().subtract(days, "day"));
  for (let page = 0; page < DETAIL_MAX_PAGES; page++) {
    const series = await client.messages.getTimeseries(agentId, "tag_values", {
      field_name: [voltagePath],
      after,
      before,
      limit: HISTORY_LIMIT,
    });
    const results = series.results ?? [];
    if (results.length === 0) break;
    let newestId: string | null = null;
    let newestTs: number | null = null;
    for (const r of results) {
      const v = extractVoltageFromSeriesValue((r as { value?: unknown }).value, voltagePath);
      let ts: number | null = null;
      try {
        ts = extractSnowflakeId(String((r as { message_id?: string }).message_id)).timestamp;
      } catch {
        ts = null;
      }
      if (ts != null && (newestTs == null || ts > newestTs)) {
        newestTs = ts;
        newestId = (r as { message_id?: string }).message_id ?? null;
      }
      if (v == null || ts == null || ts < cutoffMs) continue;
      out.push({ t: ts, v });
    }
    if (results.length < HISTORY_LIMIT) break;
    if (newestId == null) break;
    after = String(newestId);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const ONLINE_RECENT_MS = 5 * 60_000; // heard from it within this → it's up right now

/**
 * ms until the device is next expected online:
 *  - 0    → online right now (heard from it recently, or no scheduled sleep)
 *  - > 0  → asleep; this many ms until its scheduled wake
 *  - null → offline / overdue / unknown — no useful estimate
 */
function nextOnlineDeltaMs(d: DeviceRow): number | null {
  const now = Date.now();
  // Prefer `next_wake_time` from the connection config; fall back to
  // last-seen + expected_interval via `nextExpectedMs` so devices that only
  // publish their cadence (not a specific wake time) still get a useful ETA.
  const dueMs = nextExpectedMs(d.lastSeenMs, d.conn);
  const recentlyHeard = d.lastSeenMs != null && now - d.lastSeenMs < ONLINE_RECENT_MS;
  if (d.connState === "online" && (recentlyHeard || dueMs == null || dueMs <= now)) return 0;
  if (dueMs != null && dueMs > now) return dueMs - now;
  return null;
}

function NextOnlineCell({ d }: { d: DeviceRow }) {
  const delta = nextOnlineDeltaMs(d);
  if (delta === 0) return <span className="text-green-600 dark:text-green-400">now</span>;
  if (delta != null) {
    const mins = delta / 60_000;
    const label =
      mins < 90
        ? `${Math.max(1, Math.round(mins))} min`
        : mins < 60 * 36
          ? `${(mins / 60).toFixed(1)} h`
          : `${Math.round(mins / 60 / 24)} d`;
    return <span title={`scheduled wake ${dayjs(Date.now() + delta).format("ddd LLL")}`}>in {label}</span>;
  }
  if (d.connState === "overdue")
    return (
      <span className="text-amber-600 dark:text-amber-400" title="past its scheduled wake time">
        overdue
      </span>
    );
  return <span className="text-muted-foreground">—</span>;
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------
// Severity sort key — higher = more important to surface first. Dormant
// devices are expected to be silent, so they rank below active issues.
const SEVERITY_RANK: Record<Severity, number> = { offline: 4, atRisk: 3, watch: 2, dormant: 1, ok: 0 };

function statusBadge(d: DeviceRow, truncate = false) {
  let variant: "destructive" | "warning" | "muted" | "success";
  let icon: ReactNode;
  let label: string;
  let title: string | undefined;
  switch (d.severity) {
    case "offline":
      variant = "destructive";
      icon = <WifiOff />;
      label = "Offline";
      break;
    case "atRisk":
      variant = "warning";
      icon = <TriangleAlert />;
      label = "Nearly Offline";
      break;
    case "watch":
      // Surface "not charging" by name rather than the generic "Watch" when
      // that's the reason — it's the most actionable watch-level signal.
      if (d.charging?.notCharging) {
        variant = "warning";
        icon = <Unplug />;
        label = "Not charging";
        title = `No daytime charge for ${d.charging.consecutiveNotCharged} day${d.charging.consecutiveNotCharged === 1 ? "" : "s"} running — solar charging may have stopped`;
      } else {
        variant = "warning";
        icon = <AlertTriangle />;
        label = "Watch";
      }
      break;
    case "dormant":
      variant = "muted";
      icon = <Moon />;
      label = "Dormant";
      break;
    default:
      if (d.connState === "unknown") {
        variant = "muted";
        icon = <Wifi />;
        label = "Unknown";
      } else {
        variant = "success";
        icon = <Wifi />;
        label = "Online";
      }
  }
  return (
    <Badge variant={variant} title={title ?? label} className={cn(truncate && "max-w-[7.5rem]")}>
      {icon}
      <span className={cn(truncate && "min-w-0 truncate")}>{label}</span>
    </Badge>
  );
}

function batteryIcon(d: DeviceRow) {
  if (d.voltage == null) return <Battery className="text-muted-foreground" />;
  if (d.voltage <= d.band.critical) return <BatteryWarning className="text-destructive" />;
  if (d.voltage <= d.band.low) return <BatteryLow className="text-amber-600 dark:text-amber-400" />;
  return <Battery className="text-green-600 dark:text-green-400" />;
}

function VoltageCell({ d }: { d: DeviceRow }) {
  if (d.voltage == null) return <span className="text-muted-foreground">—</span>;
  const colour =
    d.voltage <= d.band.critical
      ? "text-destructive font-semibold"
      : d.voltage <= d.band.low
        ? "text-amber-600 dark:text-amber-400 font-medium"
        : "text-foreground";
  return (
    <span className="inline-flex items-center gap-1.5">
      {batteryIcon(d)}
      <span className={colour}>{d.voltage.toFixed(2)} V</span>
    </span>
  );
}

/** Trend tone — drives sparkline/arrow colour. "danger" is reserved for a real
 *  projected-flat-within-horizon situation so a noisy raw slope no longer reds. */
type TrendTone = "danger" | "down" | "up" | "flat";

function trendTone(d: DeviceRow): TrendTone {
  const t = d.trend;
  if (!t) return "flat";
  // Use the robust daily-minimum slope for direction; fall back to raw slope
  // only when we don't yet have ≥2 days of minima.
  const drain = t.dailyMinSlopePerDay ?? t.slopePerDay;
  const projectedSoon = t.projectedHoursToCutoff != null && t.projectedHoursToCutoff <= d.atRiskHorizonHours;
  if (drain < -FLAT_SLOPE_V_PER_DAY) return projectedSoon ? "danger" : "down";
  if (drain > FLAT_SLOPE_V_PER_DAY) return "up";
  return "flat";
}

const TONE_STROKE: Record<TrendTone, string> = {
  danger: "stroke-destructive",
  down: "stroke-muted-foreground",
  up: "stroke-green-600 dark:stroke-green-400",
  flat: "stroke-green-600 dark:stroke-green-400", // stable = holding charge = healthy
};

function Sparkline({ trend, tone }: { trend: TrendInfo; tone: TrendTone }) {
  const pts = trend.points;
  if (pts.length < 2) return null;
  const w = 64;
  const h = 18;
  const xs = pts.map((p) => p.t);
  const ys = pts.map((p) => p.v);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sx = (x: number) => (maxX === minX ? w / 2 : ((x - minX) / (maxX - minX)) * (w - 2) + 1);
  const sy = (y: number) => (maxY === minY ? h / 2 : h - 2 - ((y - minY) / (maxY - minY)) * (h - 4));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)} ${sy(p.v).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={path} fill="none" className={TONE_STROKE[tone]} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function spanLabel(hours: number): string {
  return hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} d`;
}

/** Relative "last seen" label that collapses near-now (within ~a minute, in
 *  either direction) to "just now" — otherwise dayjs flickers between
 *  "in a few seconds" and "a few seconds ago" as the clock crosses the timestamp. */
function lastSeenLabel(ms: number | null): string {
  if (ms == null) return "—";
  if (Math.abs(Date.now() - ms) < 60_000) return "just now";
  return dayjs(ms).fromNow();
}

/** Sleep-cycle label — minutes, switching to hours past an hour (e.g. 1440 → "24 h"). */
function sleepCycleLabel(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = mins / 60;
  return `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)} h`;
}

function TrendCell({ d }: { d: DeviceRow }) {
  if (d.historyStatus === "loading")
    return <span className="text-muted-foreground text-[0.6875rem]">…</span>;
  if (d.historyStatus === "error")
    return (
      <span className="text-amber-600 dark:text-amber-400 text-[0.6875rem]" title="failed to load voltage history">
        history error
      </span>
    );
  if (d.historyStatus === "none")
    return <span className="text-muted-foreground text-[0.6875rem]">no history</span>;
  if (d.historyStatus === "short" || !d.trend)
    return (
      <span className="text-muted-foreground text-[0.6875rem]" title="not enough voltage history yet to fit a trend">
        building…
      </span>
    );
  const slope = d.trend.slopePerDay;
  const tone = trendTone(d);
  // The sparkline's colour already conveys the trend (green stable/rising,
  // grey mild decline, red heading toward flat) — the arrow and V/day number
  // were just noise, so the cell is the sparkline alone (full detail on hover).
  return (
    <span
      className="inline-flex items-center justify-center align-middle"
      title={`${slope >= 0 ? "+" : ""}${slope.toFixed(2)} V/day over ${spanLabel(d.trend.spanHours)} of history${d.trend.dailyMinSlopePerDay != null ? ` · daily-min ${d.trend.dailyMinSlopePerDay >= 0 ? "+" : ""}${d.trend.dailyMinSlopePerDay.toFixed(2)} V/day` : ""}`}
    >
      <Sparkline trend={d.trend} tone={tone} />
    </span>
  );
}

function ProjectedCell({ d }: { d: DeviceRow }) {
  if (d.connState === "offline")
    return (
      <span className="text-destructive font-medium" title={d.lastSeenMs ? `last seen ${dayjs(d.lastSeenMs).format("ddd LLL")}` : undefined}>
        offline {d.lastSeenMs ? dayjs(d.lastSeenMs).fromNow() : ""}
      </span>
    );
  if (d.trend?.projectedHoursToCutoff == null) {
    if (!d.trend) return <span className="text-muted-foreground">{d.historyStatus === "loading" ? "…" : "—"}</span>;
    const drain = d.trend.dailyMinSlopePerDay ?? d.trend.slopePerDay;
    if (drain > -FLAT_SLOPE_V_PER_DAY) return <span className="text-muted-foreground">stable</span>;
    return <span className="text-muted-foreground" title="declining, but not enough history to project a cutoff yet">—</span>;
  }
  const hrs = d.trend.projectedHoursToCutoff;
  const danger = hrs <= d.atRiskHorizonHours;
  if (hrs <= 0)
    return (
      <span className="text-destructive font-semibold" title={`battery at/below ~${d.band.cutoff.toFixed(1)} V`}>
        imminent
      </span>
    );
  const when = dayjs().add(hrs, "hour");
  return (
    <span
      className={cn(danger ? "text-amber-600 dark:text-amber-400 font-medium" : "text-foreground")}
      title={`projected to reach ~${d.band.cutoff.toFixed(1)} V around ${when.format("ddd LLL")} (${d.trend.projectionBasis === "daily-min" ? "daily-minimum" : "raw"} trajectory) · at-risk horizon ${Math.round(d.atRiskHorizonHours / 24)} d`}
    >
      {hrs < 48 ? `~${Math.round(hrs)} h` : `~${Math.round(hrs / 24)} d`}
    </span>
  );
}

/** Human-readable issue label — internal keys stay lowercase for logic;
 *  capitalise the first letter for display ("not charging" → "Not charging"). */
function issueLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function IssuesCell({ issues }: { issues: string[] }) {
  if (issues.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap justify-center gap-1">
      {issues.map((iss) => (
        <Badge key={iss} variant="destructive">
          {issueLabel(iss)}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
type SortKey = "priority" | "displayName" | "status" | "voltage" | "lastSeen" | "projected";
type SortDir = "asc" | "desc";

function sortValue(d: DeviceRow, key: SortKey): number | string {
  switch (key) {
    case "displayName":
      return d.displayName.toLowerCase();
    case "status":
      return SEVERITY_RANK[d.severity];
    case "voltage":
      // normalise 24 V to a 12 V equivalent so mixed fleets sort sensibly
      return d.voltage == null ? Number.POSITIVE_INFINITY : d.is24v ? d.voltage / 2 : d.voltage;
    case "lastSeen":
      return d.lastSeenMs == null ? -1 : d.lastSeenMs;
    case "projected":
      return d.connState === "offline" ? -1 : (d.trend?.projectedHoursToCutoff ?? Number.POSITIVE_INFINITY);
    case "priority":
    default:
      return d.urgencyHours;
  }
}

function sortRows(rows: DeviceRow[], key: SortKey, dir: SortDir): DeviceRow[] {
  const mult = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    let cmp: number;
    if (typeof av === "string" || typeof bv === "string") cmp = String(av).localeCompare(String(bv));
    else cmp = av < bv ? -1 : av > bv ? 1 : 0;
    if (cmp === 0) cmp = a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
    return cmp * mult;
  });
}

function SortHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = current === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        "text-foreground h-9 px-2 text-center align-middle font-medium whitespace-nowrap cursor-pointer select-none hover:bg-muted/50 transition-colors",
        className,
      )}
    >
      <span className="inline-flex items-center gap-0.5">
        {label}
        {active && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {dir === "asc" ? <path d="m7 10 5-5 5 5" /> : <path d="m7 14 5 5 5-5" />}
          </svg>
        )}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Filtering — device type / solution dropdown + free-text search
// ---------------------------------------------------------------------------
const CATEGORY_FILTER_ALL = "All Devices";
type CategoryFilterValue = { kind: "type" | "solution"; name: string } | null;

/** True on phone-width viewports. Used to bump filter controls to a 16px font /
 *  taller touch target — iOS Safari zooms the page when focusing any input
 *  with a font < 16 px, so the search box must grow on phones. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * Combined device-type + solution filter, one Select with grouped sections.
 * State is a `{ kind, name } | null` tuple; the round-trip through base-ui's
 * string-only `value` (encoded `type:<name>` / `solution:<name>`) is contained
 * here, split on the first `:` so names containing `:` are safe.
 */
function CategoryFilter({
  types,
  solutions,
  value,
  onChange,
  large,
}: {
  types: string[];
  solutions: string[];
  value: CategoryFilterValue;
  onChange: (v: CategoryFilterValue) => void;
  large?: boolean;
}) {
  if (types.length === 0 && solutions.length === 0) return null;
  const encoded = value ? `${value.kind}:${value.name}` : CATEGORY_FILTER_ALL;
  return (
    <Select
      value={encoded}
      onValueChange={(v) => {
        if (typeof v !== "string" || v === CATEGORY_FILTER_ALL) return onChange(null);
        const i = v.indexOf(":");
        if (i < 0) return onChange(null);
        const kind = v.slice(0, i);
        if (kind !== "type" && kind !== "solution") return onChange(null);
        onChange({ kind, name: v.slice(i + 1) });
      }}
    >
      <SelectTrigger size={large ? "lg" : "sm"} className="max-w-64" aria-label="Filter by device type or solution">
        <SelectValue>{value ? value.name : CATEGORY_FILTER_ALL}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="w-fit min-w-(--anchor-width) max-w-[min(24rem,calc(100vw-2rem))]">
        <SelectItem value={CATEGORY_FILTER_ALL}>{CATEGORY_FILTER_ALL}</SelectItem>
        {types.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel>Device Types</SelectLabel>
            {types.map((t) => (
              <SelectItem key={`type:${t}`} value={`type:${t}`}>
                {t}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {solutions.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel>Solutions</SelectLabel>
            {solutions.map((s) => (
              <SelectItem key={`solution:${s}`} value={`solution:${s}`}>
                {s}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

/** Free-text search input with a clear (×) button once non-empty. On phones the
 *  input grows to a 16px font / taller shell so iOS Safari doesn't zoom in on focus. */
function SearchBox({ value, onChange, large }: { value: string; onChange: (v: string) => void; large?: boolean }) {
  return (
    <div className="relative inline-flex items-center">
      <Search className={cn("absolute text-muted-foreground pointer-events-none", large ? "left-2.5 size-4" : "left-2 size-3.5")} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search..."
        aria-label="Search devices by name"
        className={cn(
          "border-input bg-input/20 dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/30 placeholder:text-muted-foreground rounded-md border outline-none focus-visible:ring-[2px] [&::-webkit-search-cancel-button]:hidden",
          large ? "h-9 w-44 pl-8 pr-7 text-[16px]" : "h-7 w-44 pl-7 pr-6 text-xs",
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className={cn(
            "absolute inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            large ? "right-1.5 size-5" : "right-1 size-4",
          )}
        >
          <X className={large ? "size-3.5" : "size-3"} />
        </button>
      )}
    </div>
  );
}

interface FilterState {
  types: string[];
  solutions: string[];
  categoryFilter: CategoryFilterValue;
  onCategoryChange: (v: CategoryFilterValue) => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
}

function FilterControls({ types, solutions, categoryFilter, onCategoryChange, searchQuery, onSearchChange }: FilterState) {
  const narrow = useIsNarrow();
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <CategoryFilter types={types} solutions={solutions} value={categoryFilter} onChange={onCategoryChange} large={narrow} />
      <SearchBox value={searchQuery} onChange={onSearchChange} large={narrow} />
    </div>
  );
}

/** Apply the active category + search filters to a row list. */
function applyFilters(rows: DeviceRow[], categoryFilter: CategoryFilterValue, searchQuery: string): DeviceRow[] {
  let out = rows;
  if (categoryFilter?.kind === "type") out = out.filter((r) => r.deviceTypeName === categoryFilter.name);
  else if (categoryFilter?.kind === "solution") out = out.filter((r) => r.solutionNames.includes(categoryFilter.name));
  const q = searchQuery.trim().toLowerCase();
  if (q) out = out.filter((r) => r.displayName.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  return out;
}

// ---------------------------------------------------------------------------
// Row + table
// ---------------------------------------------------------------------------
function EtaSubLine({ d }: { d: DeviceRow }) {
  if (d.connState === "offline")
    return d.lastSeenMs ? (
      <span className="text-[0.625rem] text-destructive">{dayjs(d.lastSeenMs).fromNow()}</span>
    ) : null;
  if (d.trend?.projectedHoursToCutoff == null) return null;
  const hrs = d.trend.projectedHoursToCutoff;
  if (hrs <= 0) return <span className="text-[0.625rem] font-semibold text-destructive">imminent</span>;
  const danger = hrs <= d.atRiskHorizonHours;
  return (
    <span className={cn("text-[0.625rem]", danger ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground")}>
      ~{hrs < 48 ? `${Math.round(hrs)} h` : `${Math.round(hrs / 24)} d`}
    </span>
  );
}

function DeviceTableRow({ d, full, compact, onOpenDetail }: { d: DeviceRow; full: boolean; compact: boolean; onOpenDetail: (d: DeviceRow) => void }) {
  // Phone layout: Status (with ETA) on the left, then a truncated device name —
  // no battery column. Mirrors the connectivity dashboard's compact rows.
  if (compact) {
    return (
      <tr className="border-b transition-colors hover:bg-muted/40 cursor-pointer" onClick={() => onOpenDetail(d)}>
        <td className="w-24 p-2 align-middle text-center">
          <div className="inline-flex flex-col items-center gap-0.5 leading-tight">
            {statusBadge(d, true)}
            <EtaSubLine d={d} />
          </div>
        </td>
        <td className="p-2 align-middle">
          <span className="block max-w-[12rem] truncate font-medium" title={d.displayName}>
            {d.displayName}
          </span>
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b transition-colors hover:bg-muted/40 cursor-pointer" onClick={() => onOpenDetail(d)}>
      <td className="p-2 align-middle text-center">
        <span className={cn("font-medium", !full && "mx-auto block max-w-[18rem] truncate")} title={d.displayName}>
          {d.displayName}
        </span>
      </td>
      <td className="p-2 align-middle whitespace-nowrap text-center">
        <div className="inline-flex flex-col items-center gap-0.5 leading-tight">
          {statusBadge(d, !full)}
          {!full && <EtaSubLine d={d} />}
        </div>
      </td>
      <td className="p-2 align-middle whitespace-nowrap text-center">
        <span className="inline-flex items-center gap-2">
          <VoltageCell d={d} />
          <TrendCell d={d} />
        </span>
      </td>
      {full && (
        <>
          <td className="p-2 align-middle whitespace-nowrap text-center">
            <ProjectedCell d={d} />
          </td>
          <td className="p-2 align-middle whitespace-nowrap text-center">
            {d.lastSeenMs ? (
              <span title={dayjs(d.lastSeenMs).format("ddd, LLL")}>{lastSeenLabel(d.lastSeenMs)}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </td>
          <td className="p-2 align-middle whitespace-nowrap text-center">
            {d.chargeState ? (
              <span className="inline-flex items-center justify-center gap-1">
                <Plug className="size-3 text-muted-foreground" />
                <span className={cn(BAD_CHARGE_STATES.includes(d.chargeState.toLowerCase()) ? "text-destructive" : "text-foreground")}>
                  {d.chargeState}
                </span>
                {d.chargeCurrent != null && <span className="text-muted-foreground">({d.chargeCurrent.toFixed(1)} A)</span>}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </td>
          <td className="p-2 align-middle text-center">
            <IssuesCell issues={d.issues} />
          </td>
        </>
      )}
    </tr>
  );
}

function DeviceTable({
  rows,
  full,
  compact = false,
  sortKey,
  sortDir,
  onSort,
  onOpenDetail,
}: {
  rows: DeviceRow[];
  full: boolean;
  compact?: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  onOpenDetail: (d: DeviceRow) => void;
}) {
  const colCount = compact ? 2 : full ? 7 : 3;
  return (
    <table className="w-full caption-bottom text-xs">
      <thead className="[&_tr]:border-b">
        <tr className="border-b">
          {compact ? (
            <>
              <SortHeader label="Status" sortKey="priority" current={sortKey} dir={sortDir} onSort={onSort} className="w-24" />
              <SortHeader label="Device" sortKey="displayName" current={sortKey} dir={sortDir} onSort={onSort} />
            </>
          ) : (
            <>
              <SortHeader label="Device" sortKey="displayName" current={sortKey} dir={sortDir} onSort={onSort} />
              {full ? (
                <SortHeader label="Status" sortKey="status" current={sortKey} dir={sortDir} onSort={onSort} />
              ) : (
                <SortHeader label="Status" sortKey="priority" current={sortKey} dir={sortDir} onSort={onSort} />
              )}
              <SortHeader label="Battery" sortKey="voltage" current={sortKey} dir={sortDir} onSort={onSort} />
              {full && (
                <>
                  <SortHeader label="Projected Offline" sortKey="projected" current={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Last Seen" sortKey="lastSeen" current={sortKey} dir={sortDir} onSort={onSort} />
                  <th className="text-foreground h-9 px-2 text-center align-middle font-medium whitespace-nowrap">Charger</th>
                  <th className="text-foreground h-9 px-2 text-center align-middle font-medium whitespace-nowrap">Issues</th>
                </>
              )}
            </>
          )}
        </tr>
      </thead>
      <tbody className="[&_tr:last-child]:border-0">
        {rows.length === 0 ? (
          <tr>
            <td colSpan={colCount} className="p-6 text-center text-muted-foreground">
              No devices found. Set <span className="font-medium">Apps Installed → Solar Power Management</span> in this dashboard's
              configuration so it can see those devices.
            </td>
          </tr>
        ) : (
          rows.map((d) => <DeviceTableRow key={d.id} d={d} full={full} compact={compact} onOpenDetail={onOpenDetail} />)
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Detail dialog (row click) — battery-voltage chart + the calculations behind
// the trend, flat-battery projection and charging determination.
// ---------------------------------------------------------------------------
function StatItem({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[0.625rem] text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-foreground">{children}</span>
    </div>
  );
}

function CollapsibleSection({ title, defaultOpen = false, children }: { title: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 text-[0.625rem] text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey?: string; value?: number }[]; label?: number }) {
  if (!active || !payload?.length || label == null) return null;
  const pick = (k: string) => {
    const v = payload.find((p) => p.dataKey === k)?.value;
    return typeof v === "number" ? v : null;
  };
  const v = pick("v");
  const dmin = pick("dmin");
  const proj = pick("proj");
  return (
    <div className="rounded-md border border-border bg-background px-2 py-1 text-[0.6875rem] shadow-sm">
      <div className="text-muted-foreground">{dayjs(label).format("ddd D MMM, HH:mm")}</div>
      {v != null && <div>Voltage: <span className="font-medium tabular-nums">{v.toFixed(2)} V</span></div>}
      {dmin != null && <div>Daily min: <span className="font-medium tabular-nums">{dmin.toFixed(2)} V</span></div>}
      {proj != null && <div className="text-destructive">Projected: <span className="font-medium tabular-nums">{proj.toFixed(2)} V</span></div>}
    </div>
  );
}

const VOLT_RANGES: { days: number; label: string }[] = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
];

function VoltageChart({ trend, band, rangeDays }: { trend: TrendInfo; band: typeof BANDS.v12; rangeDays: number }) {
  const now = useMemo(() => Date.now(), []);
  const chartData = useMemo(() => {
    const map = new Map<number, { t: number; v?: number | null; dmin?: number | null; proj?: number | null }>();
    const at = (t: number) => {
      let e = map.get(t);
      if (!e) {
        e = { t };
        map.set(t, e);
      }
      return e;
    };
    for (const p of trend.points) at(p.t).v = p.v;
    for (const m of trend.dailyMins) at(m.t).dmin = m.v;
    if (trend.projectedHoursToCutoff != null) {
      // anchor the projection at the latest daily minimum, run it out to the cutoff
      at(trend.lastMs).proj = trend.latestDailyMin;
      const endT = now + trend.projectedHoursToCutoff * 3_600_000;
      at(endT).proj = band.cutoff;
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [trend, band.cutoff, now]);

  const yDomain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of chartData) {
      for (const val of [r.v, r.dmin, r.proj]) {
        if (typeof val === "number") {
          if (val < lo) lo = val;
          if (val > hi) hi = val;
        }
      }
    }
    lo = Math.min(lo, band.cutoff);
    hi = Math.max(hi, band.low);
    if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
    const pad = Math.max(0.2, (hi - lo) * 0.08);
    return [Number((lo - pad).toFixed(2)), Number((hi + pad).toFixed(2))];
  }, [chartData, band]);

  // The range picker controls only the chart's view window — the projection is
  // computed from the full 30-day daily-minimum history, so zooming in here never
  // weakens the prediction. The right edge reaches toward the projected flat
  // point, but no further than the selected window, to stay readable.
  const rangeMs = rangeDays * DAY_MS;
  const windowStart = now - rangeMs;
  const projEnd = trend.projectedHoursToCutoff != null ? now + trend.projectedHoursToCutoff * 3_600_000 : null;
  const windowEnd = projEnd != null ? Math.min(projEnd, now + rangeMs) : now;

  return (
    <ResponsiveContainer width="100%" height={210}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="t"
          type="number"
          domain={[windowStart, windowEnd]}
          allowDataOverflow
          tickFormatter={(t) => dayjs(t).format(rangeDays <= 1 ? "HH:mm" : "D MMM")}
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          minTickGap={32}
        />
        <YAxis
          domain={yDomain}
          tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          width={46}
          tickFormatter={(v) => (typeof v === "number" ? v.toFixed(1) : v)}
        />
        <Tooltip content={<ChartTooltip />} isAnimationActive={false} />
        <ReferenceLine
          y={band.cutoff}
          stroke="var(--destructive)"
          strokeDasharray="4 4"
          strokeWidth={1}
          label={{ value: `flat ${band.cutoff.toFixed(1)}V`, position: "insideBottomRight", fontSize: 9, fill: "var(--destructive)" }}
        />
        <ReferenceLine y={band.low} stroke="#d97706" strokeDasharray="2 4" strokeWidth={1} />
        <Line dataKey="v" type="monotone" stroke="var(--primary)" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} name="Voltage" />
        <Line dataKey="dmin" stroke="var(--muted-foreground)" strokeWidth={0} dot={{ r: 2, fill: "var(--muted-foreground)" }} connectNulls={false} isAnimationActive={false} name="Daily min" />
        <Line dataKey="proj" type="linear" stroke="var(--destructive)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} name="Projection" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function projectionSummary(d: DeviceRow, trend: TrendInfo | null): string {
  if (d.connState === "offline") return d.lastSeenMs ? `Offline since ${dayjs(d.lastSeenMs).format("ddd D MMM")}` : "Offline";
  const t = trend;
  if (!t) return "Not enough history yet";
  if (t.projectedHoursToCutoff == null) {
    const drain = t.dailyMinSlopePerDay ?? t.slopePerDay;
    return drain > -FLAT_SLOPE_V_PER_DAY ? "Stable / charging — no flat-battery date" : "Declining, but not enough history to project";
  }
  if (t.projectedHoursToCutoff <= 0) return `At or below flat (~${d.band.cutoff.toFixed(1)} V) now`;
  const when = dayjs().add(t.projectedHoursToCutoff, "hour");
  const eta = t.projectedHoursToCutoff < 48 ? `${Math.round(t.projectedHoursToCutoff)} h` : `${Math.round(t.projectedHoursToCutoff / 24)} d`;
  return `~${eta} → flat (~${d.band.cutoff.toFixed(1)} V) around ${when.format("ddd D MMM")}`;
}

function SolarDeviceDetailDialog({ device, onClose }: { device: DeviceRow | null; onClose: () => void }) {
  const d = device;
  const [rangeDays, setRangeDays] = useState(7);
  const client = useDooverClient();

  // The dashboard list only fetches a cheap 7-day window; the detail view pulls
  // the full 30 days for this one device (lazily, on open) so the flat-battery
  // projection here is as accurate as possible.
  const detailQuery = useQuery({
    queryKey: ["spd-detail-volt", d?.id ?? "", d?.voltagePath ?? "", DETAIL_HISTORY_DAYS],
    enabled: d != null && !!d.voltagePath,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => fetchDeviceVoltageHistory(client, d!.id, d!.voltagePath as string, DETAIL_HISTORY_DAYS),
  });
  // Prefer the 30-day detail history; fall back to the row's 7-day trend while it loads.
  const trend = useMemo(
    () => (d?.voltagePath && detailQuery.data ? computeTrend(detailQuery.data, d.band.cutoff) : null) ?? d?.trend ?? null,
    [detailQuery.data, d],
  );
  const charging = useMemo(
    () => (d?.voltagePath && detailQuery.data ? computeCharging(detailQuery.data, Date.now(), d.band) : null) ?? d?.charging ?? null,
    [detailQuery.data, d],
  );

  return (
    <Dialog open={d != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent initialFocus={false} className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        {d && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 pr-10 flex-wrap">
              <DialogTitle className="truncate">{d.displayName}</DialogTitle>
              {statusBadge(d)}
              {/* Issue chips next to the status badge. Drop "not charging" here
                  when the status badge already says it, to avoid duplication. */}
              {(d.severity === "watch" && d.charging?.notCharging
                ? d.issues.filter((i) => i !== "not charging")
                : d.issues
              ).map((iss) => (
                <Badge key={iss} variant="destructive">
                  {issueLabel(iss)}
                </Badge>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                render={<Link to={`/agent/${d.id}`} tabIndex={-1} onClick={onClose} />}
                title="Open this device's dashboard page"
              >
                <ExternalLink />
                <span>Open device page</span>
              </Button>
            </div>

            {trend ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-end gap-1">
                  {VOLT_RANGES.map((r) => (
                    <Button
                      key={r.days}
                      variant={rangeDays === r.days ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => setRangeDays(r.days)}
                    >
                      {r.label}
                    </Button>
                  ))}
                </div>
                <VoltageChart trend={trend} band={d.band} rangeDays={rangeDays} />
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-muted-foreground">
                {detailQuery.isLoading
                  ? "Loading voltage history…"
                  : detailQuery.isError
                    ? "Couldn't load voltage history."
                    : "No voltage history yet."}
              </div>
            )}

            {/* Charging health — did the battery cycle up into charge each day? */}
            {charging && charging.days.length > 0 && (
              <div className="flex flex-col items-center gap-2 border-t border-border pt-2">
                <span className="text-xs font-medium inline-flex items-center gap-1.5">
                  {charging.notCharging ? (
                    <Unplug className="size-4 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <Sun className="size-4 text-green-600 dark:text-green-400" />
                  )}
                  Daily charging
                </span>
                <span className="text-[0.6875rem] text-muted-foreground text-center">
                  Each day's peak rise above its low — green charged (≥{CHARGE_RISE_V} V rise or ≥{d.band.floatV.toFixed(1)} V peak), amber didn't.
                </span>
                <div className="flex flex-wrap justify-center gap-2">
                  {charging.days.slice(-10).map((day) => {
                    const riseV = day.max - day.min;
                    return (
                      <div key={day.d} className="flex flex-col items-center gap-1">
                        <span className="text-[0.625rem] text-muted-foreground">{dayjs(day.d * DAY_MS).format("ddd D")}</span>
                        <span
                          className={cn(
                            "rounded-md px-2 py-1 text-xs font-medium tabular-nums",
                            day.charged
                              ? "bg-green-500/15 text-green-700 dark:text-green-400"
                              : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                          )}
                        >
                          +{riseV.toFixed(1)} V
                        </span>
                      </div>
                    );
                  })}
                </div>
                {charging.notCharging && (
                  <span className="text-[0.6875rem] text-amber-700 dark:text-amber-400 font-medium text-center">
                    No daytime charge for {charging.consecutiveNotCharged} day{charging.consecutiveNotCharged === 1 ? "" : "s"} running — solar input may have failed.
                  </span>
                )}
              </div>
            )}

            {/* Device details — rail, battery, connection (collapsible, collapsed by default) */}
            <CollapsibleSection title="Details">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                <StatItem label="Rail">{d.is24v ? "24 V" : "12 V"} system</StatItem>
                <StatItem label="Battery">
                  {d.voltage != null ? <VoltageCell d={d} /> : <span className="text-muted-foreground">—</span>}
                </StatItem>
                <StatItem label="Temperature">
                  {d.temperature != null ? `${d.temperature.toFixed(1)} °C` : <span className="text-muted-foreground">—</span>}
                </StatItem>
                <StatItem label="Connection">
                  <span className="capitalize">{d.connState}</span>
                </StatItem>
                <StatItem label="Last seen">
                  {d.lastSeenMs ? lastSeenLabel(d.lastSeenMs) : <span className="text-muted-foreground">—</span>}
                </StatItem>
                <StatItem label="Next online">
                  <NextOnlineCell d={d} />
                </StatItem>
                <StatItem label="Charger">
                  {d.chargeState ? (
                    <span className={cn(BAD_CHARGE_STATES.includes(d.chargeState.toLowerCase()) ? "text-destructive" : "")}>
                      {d.chargeState}
                      {d.chargeCurrent != null && <span className="text-muted-foreground"> ({d.chargeCurrent.toFixed(1)} A)</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </StatItem>
                {d.conn?.sleep_time != null && (
                  <StatItem label="Sleep cycle">{sleepCycleLabel(d.conn.sleep_time as number)}</StatItem>
                )}
                {connToEpochMs(d.conn?.next_wake_time) != null && (
                  <StatItem label="Next wake">{dayjs(connToEpochMs(d.conn?.next_wake_time) as number).fromNow()}</StatItem>
                )}
              </div>
            </CollapsibleSection>

            {/* Trend + projection calculations (collapsed by default) */}
            {trend && (
              <CollapsibleSection title="Trend & projection">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                  <StatItem label="Raw trend">
                    <span className="tabular-nums">{trend.slopePerDay >= 0 ? "+" : ""}{trend.slopePerDay.toFixed(3)} V/day</span>
                  </StatItem>
                  <StatItem label="Daily-min trend">
                    {trend.dailyMinSlopePerDay != null ? (
                      <span className="tabular-nums">{trend.dailyMinSlopePerDay >= 0 ? "+" : ""}{trend.dailyMinSlopePerDay.toFixed(3)} V/day</span>
                    ) : (
                      <span className="text-muted-foreground">need ≥2 days</span>
                    )}
                  </StatItem>
                  <StatItem label="History">
                    {spanLabel(trend.spanHours)} · {trend.nPoints} pts
                  </StatItem>
                  <StatItem label="Projection basis">
                    {trend.projectionBasis === "daily-min" ? "daily minimum" : trend.projectionBasis === "raw" ? "raw slope" : "—"}
                  </StatItem>
                  <StatItem label="At-risk horizon">{Math.round(d.atRiskHorizonHours / 24)} days</StatItem>
                  <StatItem label="Flat-battery prediction" className="col-span-2 sm:col-span-3">
                    <span className={cn(trend.projectedHoursToCutoff != null && trend.projectedHoursToCutoff <= d.atRiskHorizonHours ? "text-amber-600 dark:text-amber-400 font-medium" : "")}>
                      {projectionSummary(d, trend)}
                    </span>
                  </StatItem>
                </div>
              </CollapsibleSection>
            )}

          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------
function SummaryCards({ rows, compact }: { rows: DeviceRow[]; compact?: boolean }) {
  const total = rows.length;
  const online = rows.filter((d) => d.severity === "ok").length;
  const nearly = rows.filter((d) => d.severity === "atRisk" || d.severity === "watch").length;
  const offline = rows.filter((d) => d.severity === "offline").length;
  const withIssues = rows.filter((d) => d.issues.length > 0).length;
  const cells: { label: string; short: string; value: number; cls: string; icon: ReactNode }[] = [
    { label: "Online", short: "online", value: online, cls: "text-green-600 dark:text-green-400", icon: <Wifi className="size-4" /> },
    { label: "Nearly Offline", short: "nearly offline", value: nearly, cls: "text-amber-600 dark:text-amber-400", icon: <TriangleAlert className="size-4" /> },
    { label: "Offline", short: "offline", value: offline, cls: "text-destructive", icon: <WifiOff className="size-4" /> },
    { label: "Power Mgmt Issues", short: "issues", value: withIssues, cls: "text-destructive", icon: <AlertTriangle className="size-4" /> },
  ];
  const totalLabel = (
    <span className="text-muted-foreground">
      <span className="font-semibold text-foreground tabular-nums">{total}</span> device{total === 1 ? "" : "s"}
    </span>
  );

  if (compact) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 mb-2 text-[0.6875rem]">
        {totalLabel}
        {cells.map((c) => (
          <span key={c.label} className="inline-flex items-center gap-1">
            <span className={cn("font-semibold tabular-nums", c.cls)}>{c.value}</span>
            <span className={c.cls}>{c.short}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="mb-1 text-[0.6875rem]">{totalLabel}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {cells.map((c) => (
          <Card key={c.label}>
            <CardContent className="flex items-center justify-between">
              <div>
                <div className="text-[0.6875rem] text-muted-foreground">{c.label}</div>
                <div className={cn("text-xl font-semibold tabular-nums", c.cls)}>{c.value}</div>
              </div>
              <div className={c.cls}>{c.icon}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fullscreen overlay
// ---------------------------------------------------------------------------
function FullscreenDialog({
  rows,
  onClose,
  sortKey,
  sortDir,
  onSort,
  onOpenDetail,
  filterState,
}: {
  rows: DeviceRow[];
  onClose: () => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  onOpenDetail: (d: DeviceRow) => void;
  filterState: FilterState;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold inline-flex items-center gap-2">
          <Battery className="size-4" /> Solar Power Fleet
        </h2>
        <button
          onClick={onClose}
          className="inline-flex items-center justify-center rounded-md border border-border h-8 w-8 hover:bg-muted/50 transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="overflow-auto p-4">
        <FilterControls {...filterState} />
        <SummaryCards rows={rows} />
        <DeviceTable rows={rows} full sortKey={sortKey} sortDir={sortDir} onSort={onSort} onOpenDetail={onOpenDetail} />
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Help dialog — explains how the dashboard's numbers are derived.
// ---------------------------------------------------------------------------
function HelpDialog() {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            title="How these numbers work"
            className="inline-flex items-center justify-center rounded-md border border-border h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          />
        }
      >
        <Info className="size-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto text-left">
        <DialogTitle className="pr-8">How these numbers work</DialogTitle>
        <dl className="flex flex-col gap-3">
          <div>
            <dt className="font-medium text-foreground">Status</dt>
            <dd className="text-muted-foreground flex flex-col gap-0.5">
              <span><span className="text-foreground font-medium">Online</span> — healthy</span>
              <span><span className="text-foreground font-medium">Watch</span> — a non-critical issue (low-ish battery, charger fault, bad data)</span>
              <span><span className="text-foreground font-medium">Not charging</span> — no daytime charge for 3+ days</span>
              <span><span className="text-foreground font-medium">Nearly Offline</span> — critically low, low-battery alarm sent, or projected flat within its horizon</span>
              <span><span className="text-foreground font-medium">Offline</span> — silent past its expected check-in</span>
              <span><span className="text-foreground font-medium">Dormant</span> — offline 30+ days</span>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Battery &amp; trend</dt>
            <dd className="text-muted-foreground">
              Voltage is the latest reading. The trend sparkline is fit through each day's <em>minimum</em> voltage (robust to daytime charging spikes); green = stable or rising, grey = mild decline, red = falling toward flat within the horizon.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Projected offline</dt>
            <dd className="text-muted-foreground">
              Takes the lowest voltage per day over the last 30 days, fits a line, and extends it to the flat-battery cutoff (~11 V / 22 V). A device projected to reach that within the at-risk horizon (configurable per device type; default 30 days) is flagged Nearly Offline.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Not charging</dt>
            <dd className="text-muted-foreground">
              A day counts as charged if its peak rose ≥1 V (or 5%) above the day's low, or reached float (~13.6 V / 27.2 V). Three completed days in a row without that ⇒ Not charging.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Next online</dt>
            <dd className="text-muted-foreground">
              For sleeping devices, the scheduled wake from its connection config; “now” if heard from in the last few minutes.
            </dd>
          </div>
        </dl>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Inner widget (has hook context via RemoteComponentWrapper)
// ---------------------------------------------------------------------------
function SolarPowerDashboardWidgetInner({ uiElement }: { uiElement: UiRemoteComponentSolar }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const dashboardAppKey = uiElement?.app_key ?? "";

  // 1. DEVICE_MAP via the typed helper — each entry rides along with the
  //    device type's `type.config.battery_voltage_tag` (a dotted path into
  //    `tag_values`, e.g. ``solar_power_management_1.system_voltage``).
  const { devices: allDevices, isLoading: cfgLoading } =
    useDeviceMap<SolarDeviceEntry>(agentId, dashboardAppKey);

  // The dashboard's own configured options live in the same `deployment_config`
  // channel — react-query dedupes the underlying fetch.
  const { data: deploymentConfig } =
    useAgentChannel<DashboardDeploymentConfig>(agentId, "deployment_config");
  const dormantAfterMs = useMemo(() => {
    const d = num(deploymentConfig?.applications?.[dashboardAppKey]?.dormant_after_days);
    return Math.max(1, d ?? DEFAULT_DORMANT_AFTER_DAYS) * DAY_MS;
  }, [deploymentConfig, dashboardAppKey]);
  // Fleet-wide fallback for the flat-battery projection horizon; device types
  // can override it with their own `flat_battery_horizon_days`.
  const defaultHorizonDays = useMemo(() => {
    const d = numLoose(deploymentConfig?.applications?.[dashboardAppKey]?.flat_battery_horizon_days);
    return Math.max(1, d ?? DEFAULT_AT_RISK_HORIZON_DAYS);
  }, [deploymentConfig, dashboardAppKey]);

  // Devices in any `ignored_groups` group are hidden entirely — applied before
  // we fetch aggregates or history for them. Group ids can be serialised as
  // strings or numbers; normalise to strings before the Set lookup.
  const ignoreGroupIds = useMemo(() => {
    const raw = deploymentConfig?.applications?.[dashboardAppKey]?.ignored_groups;
    if (!Array.isArray(raw)) return null;
    const s = new Set<string>();
    for (const v of raw) {
      if (typeof v === "string" && v) s.add(v);
      else if (typeof v === "number" && Number.isFinite(v)) s.add(String(v));
    }
    return s.size > 0 ? s : null;
  }, [deploymentConfig, dashboardAppKey]);
  const devices = useMemo(() => {
    if (!ignoreGroupIds) return allDevices;
    return allDevices.filter((d) => {
      const gid = d.group?.id;
      return gid == null || !ignoreGroupIds.has(String(gid));
    });
  }, [allDevices, ignoreGroupIds]);
  const deviceIds = useMemo(() => devices.map((d) => d.id), [devices]);

  // The first segment of each `battery_voltage_tag` is the device's PM app key
  // (e.g. ``solar_power_management_1``). We ask the multi-agent aggregate
  // endpoint for those subtrees only, via `fields` — that way each device's
  // tag_values response carries the whole PM tag subtree (voltage,
  // charge_state, charge_current, system_temperature, low_battery_warning_sent),
  // without the rest of the device's tags.
  const pmKeyByDevice = useMemo(() => {
    const m: Record<string, string | null> = {};
    for (const d of devices) {
      const path = typeof d.type?.config?.battery_voltage_tag === "string" ? d.type.config.battery_voltage_tag : null;
      m[d.id] = path ? path.split(".")[0] || null : null;
    }
    return m;
  }, [devices]);
  const uniquePmKeys = useMemo(() => {
    const s = new Set<string>();
    for (const k of Object.values(pmKeyByDevice)) if (k) s.add(k);
    return [...s];
  }, [pmKeyByDevice]);

  // 2. live tag_values + doover_connection aggregates across the fleet
  const { aggregatesByAgent: tagAggs, query: tagQuery } = useMultiAgentAggregates<TagValuesAggregate>(
    "tag_values",
    deviceIds,
    { fields: uniquePmKeys },
  );
  const { aggregatesByAgent: connAggs } = useMultiAgentAggregates<ConnectionAggregate>(
    "doover_connection",
    deviceIds,
  );

  // 3. battery-voltage history for the WHOLE fleet in one batched read (7-day
  //    window) — this keeps dashboard load to a handful of requests rather than
  //    one per device. The deeper 30-day per-device history is fetched lazily by
  //    the detail dialog when a row is opened.
  // Both cursors derive from one `top` so the batch window is exactly
  // FLEET_HISTORY_DAYS — the batch messages endpoint rejects windows over 7 days.
  // `liveUpdates: false`: the tag_values aggregate hook above already subscribes
  // to live updates; we don't want a second WebSocket subscription per device
  // just to keep this 7-day history list current.
  const fleetTop = useMemo(() => Date.now() + 60_000, []);
  const fleetBeforeCursor = useMemo(() => generateSnowflakeIdAtTime(fleetTop), [fleetTop]);
  const fleetAfterCursor = useMemo(() => generateSnowflakeIdAtTime(fleetTop - FLEET_HISTORY_DAYS * DAY_MS), [fleetTop]);
  const histAgentIds = useMemo(
    () =>
      devices
        .filter((d) => typeof d.type?.config?.battery_voltage_tag === "string")
        .map((d) => d.id),
    [devices],
  );
  const voltagePathByDevice = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of devices) {
      const p = d.type?.config?.battery_voltage_tag;
      if (typeof p === "string") m[d.id] = p;
    }
    return m;
  }, [devices]);
  const histQuery = useMultiAgentChannelMessages<unknown>("tag_values", histAgentIds, {
    initialBefore: fleetBeforeCursor,
    after: fleetAfterCursor,
    agentMessageLimit: FLEET_AGENT_MSG_LIMIT,
    fields: uniquePmKeys,
    liveUpdates: false,
  });
  const historyByAgent = useMemo<Record<string, VoltagePoint[]>>(() => {
    const out: Record<string, VoltagePoint[]> = {};
    for (const m of histQuery.messages) {
      const id = (m.channel as { agent_id?: string } | undefined)?.agent_id;
      if (!id) continue;
      const path = voltagePathByDevice[id];
      if (!path) continue;
      const v = resolveDottedNumber((m as { data?: unknown }).data, path);
      const t = typeof m.timestamp === "number" ? m.timestamp : null;
      if (v == null || t == null) continue;
      (out[id] ??= []).push({ t, v });
    }
    for (const id of Object.keys(out)) out[id].sort((a, b) => a.t - b.t);
    return out;
  }, [histQuery.messages, voltagePathByDevice]);

  // 4. assemble the rows
  const rows = useMemo<DeviceRow[]>(() => {
    const now = Date.now();
    return devices.map((dev) => {
      const tagAgg = tagAggs[dev.id];
      const voltagePath = typeof dev.type?.config?.battery_voltage_tag === "string" ? dev.type.config.battery_voltage_tag : null;
      const pmKey = pmKeyByDevice[dev.id] ?? null;
      const pmTags: Record<string, unknown> = pmKey && tagAgg?.data ? (tagAgg.data[pmKey] ?? {}) : {};
      const voltage = resolveDottedNumber(tagAgg?.data, voltagePath);
      const is24v = voltage != null && voltage > BANDS.v12.plausibleMax;
      const band = is24v ? BANDS.v24 : BANDS.v12;

      // Per-device "nearly offline" horizon: device-type override, else dashboard default.
      const typeHorizonDays = numLoose(dev.type?.config?.flat_battery_horizon_days);
      const atRiskHorizonHours = Math.max(1, typeHorizonDays ?? defaultHorizonDays) * 24;

      const connAgg = connAggs[dev.id];
      const conn = connAgg?.data?.config ?? null;
      const lastSeen = computeLastSeenMs(connAgg?.data ?? null, connToEpochMs(connAgg?.last_updated));
      // also bring the tag aggregate's last-updated in as a fallback — solar
      // devices that publish PM tags but no `doover_connection` aggregate (yet)
      // would otherwise show as "unknown" forever.
      const lastSeenMs = (() => {
        const tagLU = connToEpochMs(tagAgg?.last_updated);
        const candidates = [lastSeen, tagLU].filter((v): v is number => v != null);
        return candidates.length ? Math.max(...candidates) : null;
      })();
      const connState = classifyState(lastSeenMs, conn, now, connAgg?.data?.determination);

      const histPoints = historyByAgent[dev.id] ?? [];
      const trend = voltagePath ? computeTrend(histPoints, band.cutoff) : null;
      const charging = voltagePath ? computeCharging(histPoints, now, band) : null;
      let historyStatus: HistoryStatus;
      if (!voltagePath) historyStatus = "none";
      else if (histQuery.isError) historyStatus = "error";
      else if (histQuery.isLoading) historyStatus = "loading";
      else if (histPoints.length === 0) historyStatus = "none";
      else if (!trend) historyStatus = "short";
      else historyStatus = "ok";

      // ---- power-management fault detection ----
      // We use the dashboard's own voltage assessment ("low voltage" against the
      // critical band) rather than the device's `low_battery_warning_sent` flag,
      // which is redundant and can disagree when a device's alarm is customised.
      const chargeStateRaw = typeof pmTags.charge_state === "string" ? pmTags.charge_state : null;
      const issues: string[] = [];
      if (connState !== "offline" && !voltagePath) issues.push("device type not configured");
      else if (connState !== "offline" && voltage == null) issues.push("no battery voltage");
      if (voltage != null && (voltage < band.plausibleMin || voltage > band.plausibleMax || voltage <= 1))
        issues.push("implausible voltage");
      if (voltage != null && voltage <= band.critical) issues.push("low voltage");
      if (chargeStateRaw && BAD_CHARGE_STATES.includes(chargeStateRaw.toLowerCase()))
        issues.push("charger fault");
      if (connState !== "offline" && charging?.notCharging) issues.push("not charging");
      if (trend?.projectedHoursToCutoff != null && trend.projectedHoursToCutoff <= atRiskHorizonHours)
        issues.push("battery draining");

      // ---- overall severity ----
      let severity: Severity;
      const batteryCritical =
        (voltage != null && voltage <= band.critical) ||
        (trend?.projectedHoursToCutoff != null && trend.projectedHoursToCutoff <= atRiskHorizonHours);
      const longSilent = lastSeenMs != null && now - lastSeenMs >= dormantAfterMs;
      if (connState === "offline" && longSilent) severity = "dormant";
      else if (connState === "offline") severity = "offline";
      else if (batteryCritical || connState === "overdue") severity = "atRisk";
      else if (issues.length > 0 || (voltage != null && voltage <= band.low)) severity = "watch";
      else severity = "ok";

      // ---- urgency (ascending sort: lower = more urgent) ----
      let urgencyHours: number;
      if (severity === "dormant") urgencyHours = Number.POSITIVE_INFINITY; // expected silence — sinks to the bottom of priority sort
      else if (connState === "offline") urgencyHours = -2;
      else if (issues.includes("device type not configured") || issues.includes("no battery voltage") || issues.includes("implausible voltage"))
        urgencyHours = -1;
      else if (trend?.projectedHoursToCutoff != null) urgencyHours = trend.projectedHoursToCutoff;
      else if (voltage != null && voltage <= band.critical) urgencyHours = 6;
      else if (connState === "overdue") urgencyHours = 12;
      else if (charging?.notCharging) urgencyHours = 36;
      else if (voltage != null && voltage <= band.low) urgencyHours = 24 * 7;
      else urgencyHours = Number.POSITIVE_INFINITY;

      // Dedupe solution display names — a device can sit in several installs.
      const solutionNames = Array.isArray(dev.solution_installs)
        ? [
            ...new Set(
              dev.solution_installs
                .map((s) => (typeof s?.display_name === "string" ? s.display_name : null))
                .filter((n): n is string => !!n),
            ),
          ]
        : [];

      return {
        id: dev.id,
        name: typeof dev.name === "string" && dev.name ? dev.name : dev.id,
        displayName: displayNameOf(dev),
        deviceTypeName: typeof dev.type?.name === "string" ? dev.type.name : null,
        solutionNames,
        voltagePath,
        pmKey,
        voltage,
        temperature: num(pmTags.system_temperature),
        chargeState: chargeStateRaw,
        chargeCurrent: num(pmTags.charge_current),
        lastSeenMs,
        conn,
        connState,
        is24v,
        band,
        trend,
        charging,
        atRiskHorizonHours,
        historyStatus,
        historyPointCount: histPoints.length,
        issues,
        severity,
        urgencyHours,
      };
    });
  }, [devices, tagAggs, connAggs, historyByAgent, histQuery.isError, histQuery.isLoading, pmKeyByDevice, dormantAfterMs, defaultHorizonDays]);

  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const handleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  };
  const sortedRows = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  // Device-type / solution filter options, derived from the current fleet.
  const deviceTypeNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.deviceTypeName) s.add(r.deviceTypeName);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const solutionNamesAll = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const n of r.solutionNames) s.add(n);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilterValue>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  // A previously-selected category can disappear (config / permission change) —
  // fall back to "All Devices" so the trigger doesn't show a stale label.
  useEffect(() => {
    if (!categoryFilter) return;
    const stillThere =
      categoryFilter.kind === "type"
        ? deviceTypeNames.includes(categoryFilter.name)
        : solutionNamesAll.includes(categoryFilter.name);
    if (!stillThere) setCategoryFilter(null);
  }, [deviceTypeNames, solutionNamesAll, categoryFilter]);
  const visibleRows = useMemo(
    () => applyFilters(sortedRows, categoryFilter, searchQuery),
    [sortedRows, categoryFilter, searchQuery],
  );
  const filterState: FilterState = {
    types: deviceTypeNames,
    solutions: solutionNamesAll,
    categoryFilter,
    onCategoryChange: setCategoryFilter,
    searchQuery,
    onSearchChange: setSearchQuery,
  };

  // keep "x minutes ago" labels fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const [fullscreen, setFullscreen] = useState(false);
  const narrow = useIsNarrow(); // phone-width → compact table (status-first, no battery column)

  // Row-click detail dialog. Track the selected id (not the row object) so the
  // dialog keeps showing fresh data as aggregates/history update underneath it.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailRow = useMemo(() => rows.find((r) => r.id === detailId) ?? null, [rows, detailId]);

  // Sync the open device into the URL as `?device=<id>` so the view is shareable.
  // Go through history.replaceState directly (not react-router's setSearchParams)
  // so the host shell's chrome doesn't re-render mid-open-animation and flicker.
  const writeDeviceParam = (deviceId: string | null) => {
    const url = new URL(window.location.href);
    if (deviceId) url.searchParams.set("device", deviceId);
    else url.searchParams.delete("device");
    window.history.replaceState(window.history.state, "", url.toString());
  };
  // Deep-link: once rows resolve, open the dialog if `?device=…` names a known device.
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (deepLinkAppliedRef.current || rows.length === 0) return;
    const id = new URLSearchParams(window.location.search).get("device");
    if (id && rows.some((r) => r.id === id)) setDetailId(id);
    deepLinkAppliedRef.current = true;
  }, [rows]);
  const openDetail = (d: DeviceRow) => {
    setDetailId(d.id);
    writeDeviceParam(d.id);
  };
  const closeDetail = () => {
    setDetailId(null);
    writeDeviceParam(null);
  };

  if (cfgLoading || (deviceIds.length > 0 && tagQuery.isLoading)) {
    return <div className="p-4 text-sm text-muted-foreground">Loading devices…</div>;
  }

  return (
    <>
      <div className="relative w-full overflow-x-auto">
        <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
          <HelpDialog />
          <button
            onClick={() => setFullscreen(true)}
            title="Expand"
            className="inline-flex items-center justify-center rounded-md border border-border h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
        <FilterControls {...filterState} />
        <SummaryCards rows={visibleRows} compact />
        <DeviceTable rows={visibleRows} full={false} compact={narrow} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} onOpenDetail={openDetail} />
      </div>
      {fullscreen && (
        <FullscreenDialog
          rows={visibleRows}
          onClose={() => setFullscreen(false)}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          onOpenDetail={openDetail}
          filterState={filterState}
        />
      )}
      <SolarDeviceDetailDialog device={detailRow} onClose={closeDetail} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Wrapper — provides the redux store + query client context the hooks need
// ---------------------------------------------------------------------------
const SolarPowerDashboardWidget = (props: any) => (
  <RemoteComponentWrapper>
    <SolarPowerDashboardWidgetInner {...props} />
  </RemoteComponentWrapper>
);

export default SolarPowerDashboardWidget;
