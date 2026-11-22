import { config } from "../config.js";
import { escapeHtml } from "../telegram/format.js";

export { escapeHtml };

export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: config.TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

export function relativeAge(date: Date, now = new Date()): string {
  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);

  if (days < 1) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;

  const months = Math.floor(days / 30.44);
  if (months < 12) return months === 1 ? "hace 1 mes" : `hace ${months} meses`;

  const years = Math.floor(days / 365.25);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
