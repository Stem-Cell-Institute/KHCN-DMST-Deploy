import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { ToastProvider } from "@/shared/ui/primitives";
import { getRuntimeRouterBasename } from "@/lib/url";

/**
 * Basename runtime:
 * - /admin khi chạy sau reverse-proxy giữ nguyên prefix /admin
 * - undefined khi môi trường map app trực tiếp tại root (/documents, /module-settings)
 */
const routerBasename = getRuntimeRouterBasename();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <BrowserRouter basename={routerBasename}>
        <App />
      </BrowserRouter>
    </ToastProvider>
  </React.StrictMode>
);
