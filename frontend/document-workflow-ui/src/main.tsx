import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { ToastProvider } from "@/shared/ui/primitives";

/** Khớp với `vite.config` `base` — router so khớp pathname *sau* basename. */
const routerBasename =
  import.meta.env.BASE_URL === "/" || import.meta.env.BASE_URL === ""
    ? undefined
    : import.meta.env.BASE_URL.replace(/\/$/, "");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <BrowserRouter basename={routerBasename}>
        <App />
      </BrowserRouter>
    </ToastProvider>
  </React.StrictMode>
);
