import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import { useWaiterStore } from "../store/waiterStore";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || "https://lumiere-restaurant-backend.onrender.com";
const IDEMPOTENCY_KEY_HEADER = "X-Idempotency-Key";

function createIdempotencyKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

const axiosInstance: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor
axiosInstance.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = useWaiterStore.getState().accessToken;

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    const method = config.method?.toLowerCase();
    if ((method === "post" || method === "put") && !config.headers[IDEMPOTENCY_KEY_HEADER]) {
      config.headers[IDEMPOTENCY_KEY_HEADER] = createIdempotencyKey();
    }

    return config;
  },
  (error) => Promise.reject(error)
);

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      useWaiterStore.getState().logout();
    }

    return Promise.reject(error);
  }
);

export default axiosInstance;
