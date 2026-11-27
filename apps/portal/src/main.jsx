import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import App from "./App.jsx";
import NativeTabletModeObserver from "./NativeTabletModeObserver.jsx";
import PortalErrorBoundary from "./PortalErrorBoundary.jsx";
import "./styles.css";
import "./CalaiTheme.css";

const embedded = window.parent !== window && window.location.pathname.startsWith("/business/embedded");
// Keep the iframe's document URL on its dedicated CSP-scoped entry. Native Calai URLs remain untouched.
const controlOnly = embedded && window.location.pathname === "/business/embedded/tablet-control";
const routing = controlOnly ? <NativeTabletModeObserver/> : embedded ? <><NativeTabletModeObserver/><MemoryRouter initialEntries={["/owner/connections"]}><App/></MemoryRouter></> : <BrowserRouter basename="/business"><App/></BrowserRouter>;
createRoot(document.getElementById("root")).render(<React.StrictMode><PortalErrorBoundary>{routing}</PortalErrorBoundary></React.StrictMode>);
if ("serviceWorker" in navigator && (location.protocol !== "http:" || location.hostname === "127.0.0.1")) {
  addEventListener("load", () => navigator.serviceWorker.register("/business/portal-sw.js", { scope: "/business/" }).catch(() => {}));
}
