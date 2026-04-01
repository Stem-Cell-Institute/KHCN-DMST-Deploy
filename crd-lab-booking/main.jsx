import { createRoot } from "react-dom/client";
import App from "../crd-lab-booking.jsx";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(<App />);
}
