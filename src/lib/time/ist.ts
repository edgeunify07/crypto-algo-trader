/** India Standard Time (UTC+5:30) — used for chart axis and execution logs. */
export const IST_TZ = "Asia/Kolkata";

const istOpts: Intl.DateTimeFormatOptions = {
  timeZone: IST_TZ,
  hour12: false,
};

/** Format unix seconds for lightweight-charts crosshair / axis labels (IST). */
export function formatIstChartTime(time: unknown): string {
  if (typeof time === "object" && time !== null && "year" in (time as object)) {
    const t = time as { year: number; month: number; day: number };
    const d = new Date(Date.UTC(t.year, t.month - 1, t.day));
    return d.toLocaleDateString("en-IN", { ...istOpts, day: "2-digit", month: "short", year: "numeric" });
  }
  const sec = typeof time === "number" ? time : Number(time);
  const d = new Date(sec * 1000);
  return d.toLocaleString("en-IN", {
    ...istOpts,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Tick marks on chart time scale (IST). */
export function formatIstTickMark(time: unknown, tickMarkType: number): string {
  let sec: number;
  if (typeof time === "object" && time !== null && "year" in (time as object)) {
    const t = time as { year: number; month: number; day: number };
    sec = Date.UTC(t.year, t.month - 1, t.day) / 1000;
  } else {
    sec = typeof time === "number" ? time : Number(time);
  }
  const d = new Date(sec * 1000);
  // TickMarkType: Year=0, Month=1, DayOfMonth=2, Time=3, TimeWithSeconds=4
  if (tickMarkType <= 1) {
    return d.toLocaleDateString("en-IN", { ...istOpts, month: "short", year: "2-digit" });
  }
  if (tickMarkType === 2) {
    return d.toLocaleDateString("en-IN", { ...istOpts, day: "2-digit", month: "short" });
  }
  return d.toLocaleTimeString("en-IN", { ...istOpts, hour: "2-digit", minute: "2-digit" });
}

/** Full datetime for tables / logs (IST). */
export function formatIstDateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString("en-IN", {
    ...istOpts,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Time only for trade feed (IST). */
export function formatIstTime(msOrSec: number, isMs = true): string {
  const ms = isMs ? msOrSec : msOrSec * 1000;
  return new Date(ms).toLocaleTimeString("en-IN", {
    ...istOpts,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
