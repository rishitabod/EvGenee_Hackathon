import axios from "axios";

export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string) || "http://localhost:5000/api/v1";

export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 20000,
});

const TOKEN_KEY = "voltgo_token";

export const tokenStore = {
  get: () => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(TOKEN_KEY);
  },
  set: (t: string) => {
    if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, t);
  },
  clear: () => {
    if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
  },
};

api.interceptors.request.use((config) => {
  const t = tokenStore.get();
  if (t) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>).Authorization = `Bearer ${t}`;
  }
  return config;
});

export type Vehicle = {
  type?: "EV" | "Hybrid" | "Petrol" | "Diesel";
  batteryCapacity?: number;
  connectorType?: "CCS2" | "CHAdeMO" | "Type2";
};

export type AuthUser = {
  id: string;
  _id?: string;
  name: string;
  email: string;
  role: "user" | "StationOwner" | "admin";
  vehicle?: Vehicle;
  vehicleNumbers?: string[];
  createdAt?: string;
};

export type Pricing = {
  priceperKWh: number;
  connectorType: string;
  currency: "INR" | "USD" | "EUR";
  portCount: number;
};

export type Station = {
  _id: string;
  name: string;
  ownerofStation: string | { _id: string; name: string; email: string };
  location: { type: "Point"; coordinates: [number, number] };
  address: { city: string; state: string; country: string; postalCode: string; street: string };
  amenities: string[];
  totalPorts: number;
  availablePorts: number;
  chargingSpeed: number;
  typeOfConnectors: string[];
  pricing: Pricing[];
  platformFee: number;
  isOpen: boolean;
  openingHours: string;
  contactInfo: { phoneNumber: string; email: string };
  status: "active" | "inactive";
  operator: string;
  Images: string[];
  reviews: { userId: string; comment: string; rating: number }[];
  distance?: number;
  distanceKm?: number;
  peakPricing?: { startTime: string; endTime: string; multiplier: number }[];
};

export type Booking = {
  _id: string;
  user: string | AuthUser;
  station: string | Station;
  connectorType: string;
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  estimatedKWh: number;
  totalCost: number;
  platformFee: number;
  grandTotal: number;
  vehicleNumber: string;
  status: "pending" | "confirmed" | "in-progress" | "completed" | "cancelled" | "no-show";
  cancelledAt?: string | null;
  cancellationReason?: string;
  checkedInAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
};

// ===== Auth =====
export const AuthAPI = {
  register: (d: {
    name: string;
    email: string;
    password: string;
    role?: string;
    vehicle?: Vehicle;
  }) => api.post("/users/register", d),
  login: (d: { email: string; password: string }) => api.post("/users/login", d),
  profile: () => api.get("/users/profile"),
  updateProfile: (d: { name?: string; vehicle?: Vehicle; vehicleNumbers?: string[] }) => api.put("/users/profile", d),
  logout: () => api.post("/users/logout"),
};

// ===== Stations =====
export const StationsAPI = {
  nearby: (params: { lat: number; lng: number; maxDistance?: number; connectorType?: string }) =>
    api.get("/stations/nearby", { params }),
  add: (d: Partial<Station>) => api.post("/stations/add", d),
  myStations: () => api.get("/stations/owner/my-stations"),
  details: (id: string) => api.get(`/stations/${id}`),
  update: (id: string, d: Partial<Station>) => api.put(`/stations/${id}`, d),
  toggle: (id: string) => api.patch(`/stations/${id}/toggle`),
  review: (id: string, d: { comment: string; rating: number }) =>
    api.post(`/stations/${id}/review`, d),
};

// ===== Bookings =====
export const BookingsAPI = {
  validate: (d: {
    station: string;
    connectorType: string;
    date: string;
    startTime: string;
    endTime: string;
    vehicleNumber?: string;
  }) => api.post("/bookings/validate", d),
  create: (d: {
    station: string;
    connectorType: string;
    date: string;
    startTime: string;
    endTime: string;
    vehicleNumber?: string;
  }) => api.post("/bookings/create", d),
  availability: (params: { stationId: string; date: string; connectorType?: string }) =>
    api.get("/bookings/availability", { params }),
  my: (params?: { status?: string; page?: number; limit?: number }) =>
    api.get("/bookings/my-bookings", { params }),
  details: (id: string) => api.get(`/bookings/${id}`),
  station: (
    id: string,
    params?: { status?: string; date?: string; page?: number; limit?: number },
  ) => api.get(`/bookings/station/${id}`, { params }),
  cancel: (id: string, d?: { reason?: string }) => api.post(`/bookings/${id}/cancel`, d ?? {}),
  checkIn: (id: string, d: { otp: string }) => api.post(`/bookings/${id}/check-in`, d),
  complete: (id: string) => api.post(`/bookings/${id}/complete`),
  confirmAdvance: (id: string) => api.post(`/bookings/${id}/confirm-advance`),
};

// ===== Payments =====
export const PaymentAPI = {
  createOrder: (d: { amount: number; currency: string }) => api.post("/payment/create-order", d),
  updatePayment: (d: { orderId: string; paymentId: string; status: string }) =>
    api.post("/payment/update-payment", d),
};

// ===== AI Voice Assistant =====
export const AIAPI = {
  chat: (d: { message: string; threadId?: string }) => api.post("/ai/chat", d),
};
