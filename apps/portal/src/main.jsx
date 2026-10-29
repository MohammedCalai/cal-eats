import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./styles.css";
import "./CalaiTheme.css";

createRoot(document.getElementById("root")).render(<React.StrictMode><BrowserRouter basename="/business"><App /></BrowserRouter></React.StrictMode>);
if ("serviceWorker" in navigator && (location.protocol !== "http:" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => navigator.serviceWorker.register("/business/portal-sw.js", { scope: "/business/" }).catch(() => {}));
}
