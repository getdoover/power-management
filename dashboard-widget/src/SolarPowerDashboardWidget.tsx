import "./styles.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import {
  useAgentChannel,
  useDeviceMap,
  useDooverClient,
  useMultiAgentAggregates,
  type DeviceMapEntry,
} from "doover-js/react";
import { extractSnowflakeId, generateSnowflakeIdAtTime } from "doover-js";
import { useQueries } from "@tanstack/react-query";

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import localizedFormat from "dayjs/plugin/localizedFormat";

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Battery,
  BatteryLow,
  BatteryWarning,
  Maximize2,
  Moon,
  Plug,
  TriangleAlert,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import { cn } from "./components/ui/utils";
import { Badge } from "./components/ui/badge";
import { Card, CardContent } from "./components/ui/card";
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
const HISTORY_DAYS = 7; // window of battery-voltage history pulled for the trend
const HISTORY_LIMIT = 1499; // cap on points from the timeseries endpoint (API requires < 1500)
const AT_RISK_HORIZON_HOURS = 72; // projected to die within this window → "at risk"
const MIN_TREND_SPAN_HOURS = 1; // need at least this much spread before we'll draw a trend
const MIN_PROJECT_SPAN_HOURS = 18; // ...and at least this much before we'll project to a cutoff
const FLAT_SLOPE_V_PER_DAY = 0.02; // |slope| below this is treated as "stable"
const DEFAULT_DORMANT_AFTER_DAYS = 30; // offline for at least this long → "dormant" instead of "offline"
const DAY_MS = 86_400_000;

// Per-rail battery voltage bands. 24 V systems are detected by voltage > 17.
const BANDS = {
  v12: { low: 12.0, critical: 11.4, cutoff: 11.0, plausibleMin: 5, plausibleMax: 17 },
  v24: { low: 24.0, critical: 22.8, cutoff: 22.0, plausibleMin: 17, plausibleMax: 34 },
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
 */
interface SolarDeviceEntry extends DeviceMapEntry {
  type?: {
    id?: string | number | null;
    name?: string | null;
    config?: {
      battery_voltage_tag?: string | null;
    } | null;
  } | null;
}

/** Per-device `tag_values` aggregate shape: `{ <app_key>: { <tag_name>: value } }`. */
type TagValuesAggregate = Record<string, Record<string, unknown> | undefined>;

/**
 * Shape of the bits of `deployment_config` we care about — the dashboard
 * app's own block, where its configured options (dormant_after_days,
 * ignored_groups) live alongside the platform-injected `DEVICE_MAP`.
 */
interface DashboardDeploymentConfig {
  applications?: Record<
    string,
    {
      dormant_after_days?: number | null;
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
  latestV: number; // most recent voltage point
  latestDailyMin: number; // most recent daily-minimum voltage (the projection's starting point)
  nPoints: number; // raw history points the fit is based on
  firstMs: number; // timestamp of the oldest history point
  lastMs: number; // timestamp of the newest history point
  points: { t: number; v: number }[]; // raw history points (downsampled for the sparkline), ascending
  spanHours: number; // time span of the available history
  projectedHoursToCutoff: number | null; // null = stable / rising / not enough history to project
  projectionBasis: "daily-min" | "raw" | null;
}

interface DeviceRow {
  id: string;
  name: string;
  displayName: string;
  deviceTypeName: string | null;
  /** Dotted path declared by the device type, e.g. ``"solar_power_management_1.system_voltage"``. Null when the type isn't configured. */
  voltagePath: string | null;
  /** First segment of `voltagePath` — the PM app key on this device (e.g. ``"solar_power_management_1"``). */
  pmKey: string | null;
  voltage: number | null;
  temperature: number | null;
  chargeState: string | null;
  chargeCurrent: number | null;
  lowBattWarningSent: boolean;
  lastSeenMs: number | null;
  conn: ConnectionAggregate["config"] | null;
  connState: ConnState;
  is24v: boolean;
  band: typeof BANDS.v12;
  trend: TrendInfo | null;
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

  // Daily minima for the (preferred) projection basis.
  const byDay = new Map<number, number>();
  for (const p of sorted) {
    const d = Math.floor(p.t / 86_400_000);
    const cur = byDay.get(d);
    if (cur === undefined || p.v < cur) byDay.set(d, p.v);
  }
  const dayMins = [...byDay.entries()].map(([d, v]) => ({ d, v })).sort((a, b) => a.d - b.d);

  let projectedHoursToCutoff: number | null = null;
  let projectionBasis: "daily-min" | "raw" | null = null;
  if (dayMins.length >= 2 && dayMins[dayMins.length - 1].d - dayMins[0].d >= 1) {
    const dmSlopePerDay = linFitSlope(dayMins.map((x) => ({ x: x.d, y: x.v })));
    const latestMin = dayMins[dayMins.length - 1].v;
    if (dmSlopePerDay != null && dmSlopePerDay < -FLAT_SLOPE_V_PER_DAY && latestMin > cutoff) {
      projectedHoursToCutoff = Math.max(0, ((latestMin - cutoff) / -dmSlopePerDay) * 24);
      projectionBasis = "daily-min";
    } else if (dmSlopePerDay != null && dmSlopePerDay < -FLAT_SLOPE_V_PER_DAY) {
      projectedHoursToCutoff = 0; // daily minimum already at/below cutoff
      projectionBasis = "daily-min";
    }
  } else if (spanHours >= MIN_PROJECT_SPAN_HOURS && slopePerDay < -FLAT_SLOPE_V_PER_DAY) {
    projectedHoursToCutoff = latestV > cutoff ? Math.max(0, ((latestV - cutoff) / -slopePerDay) * 24) : 0;
    projectionBasis = "raw";
  }

  return {
    slopePerDay,
    latestV,
    latestDailyMin: dayMins[dayMins.length - 1].v,
    nPoints: sorted.length,
    firstMs: sorted[0].t,
    lastMs: sorted[sorted.length - 1].t,
    points: downsampleEvenly(sorted, 40),
    spanHours,
    projectedHoursToCutoff,
    projectionBasis,
  };
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

function nextOnlineSortValue(d: DeviceRow): number {
  const delta = nextOnlineDeltaMs(d);
  if (delta != null) return delta; // 0 = now, then soonest wake first
  return d.connState === "overdue" ? 1e15 : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------
// Severity sort key — higher = more important to surface first. Dormant
// devices are expected to be silent, so they rank below active issues.
const SEVERITY_RANK: Record<Severity, number> = { offline: 4, atRisk: 3, watch: 2, dormant: 1, ok: 0 };

function statusBadge(d: DeviceRow) {
  switch (d.severity) {
    case "offline":
      return (
        <Badge variant="destructive">
          <WifiOff /> Offline
        </Badge>
      );
    case "atRisk":
      return (
        <Badge variant="warning">
          <TriangleAlert /> Nearly Offline
        </Badge>
      );
    case "watch":
      return (
        <Badge variant="warning">
          <AlertTriangle /> Watch
        </Badge>
      );
    case "dormant":
      return (
        <Badge variant="muted">
          <Moon /> Dormant
        </Badge>
      );
    default:
      if (d.connState === "unknown")
        return (
          <Badge variant="muted">
            <Wifi /> Unknown
          </Badge>
        );
      return (
        <Badge variant="success">
          <Wifi /> Online
        </Badge>
      );
  }
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

function Sparkline({ trend }: { trend: TrendInfo }) {
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
  const colour =
    trend.slopePerDay < -FLAT_SLOPE_V_PER_DAY
      ? "stroke-destructive"
      : trend.slopePerDay > FLAT_SLOPE_V_PER_DAY
        ? "stroke-green-600 dark:stroke-green-400"
        : "stroke-muted-foreground";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={path} fill="none" className={colour} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function spanLabel(hours: number): string {
  return hours < 48 ? `${Math.round(hours)} h` : `${Math.round(hours / 24)} d`;
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
  const arrow =
    slope < -FLAT_SLOPE_V_PER_DAY ? (
      <ArrowDownRight className="size-3.5 text-destructive" />
    ) : slope > FLAT_SLOPE_V_PER_DAY ? (
      <ArrowUpRight className="size-3.5 text-green-600 dark:text-green-400" />
    ) : (
      <ArrowRight className="size-3.5 text-muted-foreground" />
    );
  return (
    <span
      className="inline-flex items-center justify-center gap-1.5 align-middle"
      title={`${slope >= 0 ? "+" : ""}${slope.toFixed(2)} V/day over ${spanLabel(d.trend.spanHours)} of history${d.trend.projectionBasis === "daily-min" ? " · projection from daily minimum" : ""}`}
    >
      <Sparkline trend={d.trend} />
      {arrow}
      <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
        {slope >= 0 ? "+" : ""}
        {slope.toFixed(2)}/d
      </span>
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
    if (d.trend.slopePerDay > -FLAT_SLOPE_V_PER_DAY) return <span className="text-muted-foreground">stable</span>;
    return <span className="text-muted-foreground" title="declining, but not enough history to project a cutoff yet">—</span>;
  }
  const hrs = d.trend.projectedHoursToCutoff;
  const danger = hrs <= AT_RISK_HORIZON_HOURS;
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
      title={`projected to reach ~${d.band.cutoff.toFixed(1)} V around ${when.format("ddd LLL")} (${d.trend.projectionBasis === "daily-min" ? "daily-minimum" : "raw"} trajectory)`}
    >
      {hrs < 48 ? `~${Math.round(hrs)} h` : `~${Math.round(hrs / 24)} d`}
    </span>
  );
}

function IssuesCell({ issues }: { issues: string[] }) {
  if (issues.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap justify-center gap-1">
      {issues.map((iss) => (
        <Badge key={iss} variant="destructive">
          {iss}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
type SortKey = "priority" | "displayName" | "status" | "voltage" | "lastSeen" | "projected" | "trend" | "nextOnline";
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
    case "trend":
      return d.trend ? d.trend.slopePerDay : Number.POSITIVE_INFINITY;
    case "nextOnline":
      return nextOnlineSortValue(d);
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
  const danger = hrs <= AT_RISK_HORIZON_HOURS;
  return (
    <span className={cn("text-[0.625rem]", danger ? "text-amber-600 dark:text-amber-400 font-medium" : "text-muted-foreground")}>
      ~{hrs < 48 ? `${Math.round(hrs)} h` : `${Math.round(hrs / 24)} d`}
    </span>
  );
}

function DeviceTableRow({ d, full }: { d: DeviceRow; full: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="border-b transition-colors hover:bg-muted/40 cursor-pointer"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="p-2 align-middle whitespace-nowrap text-center">
          <span className="inline-flex items-center justify-center gap-1">
            <Link
              to={`/agent/${d.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-primary hover:underline underline-offset-4 font-medium"
            >
              {d.displayName}
            </Link>
            {d.issues.length > 0 && (
              <span title={`Power-management issues: ${d.issues.join(" · ")}`} className="inline-flex shrink-0">
                <AlertTriangle className="size-3 text-destructive" />
              </span>
            )}
          </span>
        </td>
        <td className="p-2 align-middle whitespace-nowrap text-center">
          <div className="inline-flex flex-col items-center gap-0.5 leading-tight">
            {statusBadge(d)}
            {!full && <EtaSubLine d={d} />}
          </div>
        </td>
        <td className="p-2 align-middle whitespace-nowrap text-center">
          <VoltageCell d={d} />
        </td>
        <td className="p-2 align-middle whitespace-nowrap text-center">
          {full ? <ProjectedCell d={d} /> : <TrendCell d={d} />}
        </td>
        {!full && (
          <td className="p-2 align-middle whitespace-nowrap text-center">
            <NextOnlineCell d={d} />
          </td>
        )}
        {full && (
          <>
            <td className="p-2 align-middle whitespace-nowrap text-center">
              <TrendCell d={d} />
            </td>
            <td className="p-2 align-middle whitespace-nowrap text-center">
              {d.lastSeenMs ? (
                <span title={dayjs(d.lastSeenMs).format("ddd, LLL")}>{dayjs(d.lastSeenMs).fromNow()}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className="p-2 align-middle whitespace-nowrap text-center">
              <NextOnlineCell d={d} />
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
      {open && (
        <tr className="border-b bg-muted/30">
          <td colSpan={full ? 9 : 5} className="px-4 py-2 text-[0.6875rem]">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                <span className="text-muted-foreground">Rail: </span>
                <span className="font-medium">{d.is24v ? "24 V" : "12 V"}</span>
              </span>
              {d.temperature != null && (
                <span>
                  <span className="text-muted-foreground">Temp: </span>
                  <span className="font-medium">{d.temperature.toFixed(1)} °C</span>
                </span>
              )}
              {d.trend ? (
                <span title={`least-squares fit through ${d.trend.nPoints} points · ${dayjs(d.trend.firstMs).format("D MMM HH:mm")} – ${dayjs(d.trend.lastMs).format("D MMM HH:mm")}`}>
                  <span className="text-muted-foreground">Voltage trend: </span>
                  <span className="font-medium">
                    {d.trend.slopePerDay >= 0 ? "+" : ""}
                    {d.trend.slopePerDay.toFixed(3)} V/day
                  </span>
                  <span className="text-muted-foreground">
                    {" "}over {spanLabel(d.trend.spanHours)} ({d.trend.nPoints} pts,{" "}
                    {d.trend.projectionBasis === "daily-min" ? "daily-min" : "raw"} basis)
                    {d.trend.projectedHoursToCutoff != null && (
                      <>
                        {" → daily-min "}
                        {d.trend.latestDailyMin.toFixed(2)} V, ~
                        {d.trend.projectedHoursToCutoff < 48
                          ? `${Math.round(d.trend.projectedHoursToCutoff)} h`
                          : `${Math.round(d.trend.projectedHoursToCutoff / 24)} d`}{" "}
                        to {d.band.cutoff.toFixed(1)} V
                      </>
                    )}
                  </span>
                </span>
              ) : d.historyStatus === "short" ? (
                <span className="text-muted-foreground">
                  Voltage history: {d.historyPointCount} pts (not enough span yet to fit a trend)
                </span>
              ) : null}
              {!full && (
                <>
                  <span>
                    <span className="text-muted-foreground">Last seen: </span>
                    <span className="font-medium">{d.lastSeenMs ? dayjs(d.lastSeenMs).fromNow() : "—"}</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Projected: </span>
                    <ProjectedCell d={d} />
                  </span>
                  {d.chargeState && (
                    <span>
                      <span className="text-muted-foreground">Charger: </span>
                      <span className="font-medium">{d.chargeState}</span>
                    </span>
                  )}
                </>
              )}
              {d.conn?.sleep_time != null && (
                <span>
                  <span className="text-muted-foreground">Sleep cycle: </span>
                  <span className="font-medium">{Math.round((d.conn.sleep_time as number) / 60)} min</span>
                </span>
              )}
              {connToEpochMs(d.conn?.next_wake_time) != null && (
                <span>
                  <span className="text-muted-foreground">Next wake: </span>
                  <span className="font-medium">{dayjs(connToEpochMs(d.conn?.next_wake_time) as number).fromNow()}</span>
                </span>
              )}
              {!full && d.issues.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-muted-foreground">Issues: </span>
                  <IssuesCell issues={d.issues} />
                </span>
              )}
              {d.lowBattWarningSent && <span className="text-destructive font-medium">low-battery notification sent</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DeviceTable({
  rows,
  full,
  sortKey,
  sortDir,
  onSort,
}: {
  rows: DeviceRow[];
  full: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  return (
    <table className="w-full caption-bottom text-xs">
      <thead className="[&_tr]:border-b">
        <tr className="border-b">
          <SortHeader label="Device" sortKey="displayName" current={sortKey} dir={sortDir} onSort={onSort} />
          {full ? (
            <SortHeader label="Status" sortKey="status" current={sortKey} dir={sortDir} onSort={onSort} />
          ) : (
            <SortHeader label="Status / ETA" sortKey="priority" current={sortKey} dir={sortDir} onSort={onSort} />
          )}
          <SortHeader label="Battery" sortKey="voltage" current={sortKey} dir={sortDir} onSort={onSort} />
          {full ? (
            <SortHeader label="Projected Offline" sortKey="projected" current={sortKey} dir={sortDir} onSort={onSort} />
          ) : (
            <SortHeader label="Trend" sortKey="trend" current={sortKey} dir={sortDir} onSort={onSort} />
          )}
          {!full && <SortHeader label="Online" sortKey="nextOnline" current={sortKey} dir={sortDir} onSort={onSort} />}
          {full && (
            <>
              <SortHeader label="Trend" sortKey="trend" current={sortKey} dir={sortDir} onSort={onSort} />
              <SortHeader label="Last Seen" sortKey="lastSeen" current={sortKey} dir={sortDir} onSort={onSort} />
              <SortHeader label="Online" sortKey="nextOnline" current={sortKey} dir={sortDir} onSort={onSort} />
              <th className="text-foreground h-9 px-2 text-center align-middle font-medium whitespace-nowrap">Charger</th>
              <th className="text-foreground h-9 px-2 text-center align-middle font-medium whitespace-nowrap">Issues</th>
            </>
          )}
        </tr>
      </thead>
      <tbody className="[&_tr:last-child]:border-0">
        {rows.length === 0 ? (
          <tr>
            <td colSpan={full ? 9 : 5} className="p-6 text-center text-muted-foreground">
              No devices found. Set <span className="font-medium">Apps Installed → Solar Power Management</span> in this dashboard's
              configuration so it can see those devices.
            </td>
          </tr>
        ) : (
          rows.map((d) => <DeviceTableRow key={d.id} d={d} full={full} />)
        )}
      </tbody>
    </table>
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
}: {
  rows: DeviceRow[];
  onClose: () => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
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
        <SummaryCards rows={rows} />
        <DeviceTable rows={rows} full sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Inner widget (has hook context via RemoteComponentWrapper)
// ---------------------------------------------------------------------------
function SolarPowerDashboardWidgetInner({ uiElement }: { uiElement: UiRemoteComponentSolar }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const dashboardAppKey = uiElement?.app_key ?? "";

  const client = useDooverClient();

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

  // 3. battery-voltage history per device (for the trend / projection)
  // doover-data returns oldest-first (capped at `limit`) when *both* before+after
  // are given — so for a chatty device that would hand back the ~1499 OLDEST
  // points in the window. Instead we ask only with `before` (newest-first), grab
  // the most recent ≤1499 points, and trim to the last HISTORY_DAYS client-side.
  const untilCursor = useMemo(() => generateSnowflakeIdAtTime(dayjs().add(2, "minute")), []);
  const cutoffMs = useMemo(() => dayjs().subtract(HISTORY_DAYS, "day").valueOf(), []);
  const histResults = useQueries({
    queries: devices.map((d) => {
      const voltagePath = typeof d.type?.config?.battery_voltage_tag === "string" ? d.type.config.battery_voltage_tag : null;
      return {
        queryKey: ["spd-volt-history", d.id, voltagePath, untilCursor] as const,
        enabled: !!d.id && !!voltagePath,
        staleTime: 5 * 60_000,
        gcTime: 15 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
        queryFn: async () => {
          const path = voltagePath as string;
          const series = await client.messages.getTimeseries(d.id, "tag_values", {
            field_name: [path],
            before: untilCursor,
            limit: HISTORY_LIMIT,
          });
          const out: { t: number; v: number }[] = [];
          for (const r of series.results ?? []) {
            const v = extractVoltageFromSeriesValue((r as any).value, path);
            if (v == null) continue;
            // each result carries its own timestamp; fall back to the snowflake id
            let ts = connToEpochMs((r as any).timestamp);
            if (ts == null) {
              try {
                ts = extractSnowflakeId(String((r as any).message_id)).timestamp;
              } catch {
                ts = null;
              }
            }
            if (ts == null || ts < cutoffMs) continue;
            out.push({ t: ts, v });
          }
          out.sort((a, b) => a.t - b.t);
          return out;
        },
      };
    }),
  });

  // 4. assemble the rows
  const rows = useMemo<DeviceRow[]>(() => {
    const now = Date.now();
    return devices.map((dev, i) => {
      const tagAgg = tagAggs[dev.id];
      const voltagePath = typeof dev.type?.config?.battery_voltage_tag === "string" ? dev.type.config.battery_voltage_tag : null;
      const pmKey = pmKeyByDevice[dev.id] ?? null;
      const pmTags: Record<string, unknown> = pmKey && tagAgg?.data ? (tagAgg.data[pmKey] ?? {}) : {};
      const voltage = resolveDottedNumber(tagAgg?.data, voltagePath);
      const is24v = voltage != null && voltage > BANDS.v12.plausibleMax;
      const band = is24v ? BANDS.v24 : BANDS.v12;

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

      const hr = histResults[i];
      const histPoints = (hr?.data as { t: number; v: number }[] | undefined) ?? [];
      const trend = voltagePath ? computeTrend(histPoints, band.cutoff) : null;
      let historyStatus: HistoryStatus;
      if (!voltagePath) historyStatus = "none";
      else if (hr?.isError) historyStatus = "error";
      else if (hr?.isPending && hr?.fetchStatus === "fetching") historyStatus = "loading";
      else if (histPoints.length === 0) historyStatus = "none";
      else if (!trend) historyStatus = "short";
      else historyStatus = "ok";

      // ---- power-management fault detection ----
      const chargeStateRaw = typeof pmTags.charge_state === "string" ? pmTags.charge_state : null;
      const lowBattWarningSent = pmTags.low_battery_warning_sent === true;
      const issues: string[] = [];
      if (connState !== "offline" && !voltagePath) issues.push("device type not configured");
      else if (connState !== "offline" && voltage == null) issues.push("no battery voltage");
      if (voltage != null && (voltage < band.plausibleMin || voltage > band.plausibleMax || voltage <= 1))
        issues.push("implausible voltage");
      if (voltage != null && voltage <= band.critical) issues.push("critically low voltage");
      if (lowBattWarningSent) issues.push("low-battery warning");
      if (chargeStateRaw && BAD_CHARGE_STATES.includes(chargeStateRaw.toLowerCase()))
        issues.push("charger fault");
      if (trend?.projectedHoursToCutoff != null && trend.projectedHoursToCutoff <= AT_RISK_HORIZON_HOURS)
        issues.push("battery draining");
      const sleepTime = num(conn?.sleep_time);
      if (sleepTime != null && sleepTime > 4 * 3600) issues.push("long sleep cycle");

      // ---- overall severity ----
      let severity: Severity;
      const batteryCritical =
        (voltage != null && voltage <= band.critical) ||
        lowBattWarningSent ||
        (trend?.projectedHoursToCutoff != null && trend.projectedHoursToCutoff <= AT_RISK_HORIZON_HOURS);
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
      else if (lowBattWarningSent || (voltage != null && voltage <= band.critical)) urgencyHours = 6;
      else if (connState === "overdue") urgencyHours = 12;
      else if (voltage != null && voltage <= band.low) urgencyHours = 24 * 7;
      else urgencyHours = Number.POSITIVE_INFINITY;

      return {
        id: dev.id,
        name: typeof dev.name === "string" && dev.name ? dev.name : dev.id,
        displayName: displayNameOf(dev),
        deviceTypeName: typeof dev.type?.name === "string" ? dev.type.name : null,
        voltagePath,
        pmKey,
        voltage,
        temperature: num(pmTags.system_temperature),
        chargeState: chargeStateRaw,
        chargeCurrent: num(pmTags.charge_current),
        lowBattWarningSent,
        lastSeenMs,
        conn,
        connState,
        is24v,
        band,
        trend,
        historyStatus,
        historyPointCount: histPoints.length,
        issues,
        severity,
        urgencyHours,
      };
    });
  }, [devices, tagAggs, connAggs, histResults, pmKeyByDevice, dormantAfterMs]);

  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const handleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "displayName" ? "asc" : k === "voltage" ? "asc" : "asc");
    }
  };
  const sortedRows = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  // keep "x minutes ago" labels fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const [fullscreen, setFullscreen] = useState(false);

  if (cfgLoading || (deviceIds.length > 0 && tagQuery.isLoading)) {
    return <div className="p-4 text-sm text-muted-foreground">Loading devices…</div>;
  }

  return (
    <>
      <div className="relative w-full overflow-x-auto">
        <button
          onClick={() => setFullscreen(true)}
          title="Expand"
          className="absolute top-1 right-1 z-10 inline-flex items-center justify-center rounded-md border border-border h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <Maximize2 className="size-3.5" />
        </button>
        <SummaryCards rows={sortedRows} compact />
        <DeviceTable rows={sortedRows} full={false} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
      </div>
      {fullscreen && (
        <FullscreenDialog
          rows={sortedRows}
          onClose={() => setFullscreen(false)}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
        />
      )}
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
