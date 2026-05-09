import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(n: number, currency: string = "INR") {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function getApiError(e: unknown, fallback = "Something went wrong") {
  if (typeof e === "object" && e && "response" in e) {
    // @ts-expect-error axios shape
    const data = e.response?.data;
    if (data?.errors && Array.isArray(data.errors) && data.errors.length > 0) {
      return data.errors.map((err: any) => err.message).join(", ");
    }
    return data?.message || fallback;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}
