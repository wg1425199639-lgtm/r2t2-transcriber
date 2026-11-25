import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CaptionOverlay } from "./components/CaptionOverlay";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing application root");
}

const params = new URLSearchParams(window.location.search);
const isOverlay = params.get("view") === "overlay";
if (isOverlay) {
  document.documentElement.dataset.overlay = "true";
}

createRoot(root).render(
  <StrictMode>
    {isOverlay ? <CaptionOverlay obsMode={params.get("obs") === "1"} /> : <App />}
  </StrictMode>,
);
