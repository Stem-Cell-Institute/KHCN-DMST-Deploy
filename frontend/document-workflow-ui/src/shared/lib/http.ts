import axios from "axios";
import { getToken } from "@/lib/auth";

function baseURL() {
  const envBase = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_API_BASE;
  return envBase || "";
}

/**
 * HTTP client chung cho toan FE. Dung axios + JWT interceptor.
 */
export const api = axios.create({
  baseURL: baseURL(),
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
