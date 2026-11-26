import { Map, NavigationControl, setWorkerUrl } from "/assets/maplibre-gl.mjs";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const UK_BOUNDS = [[-8.8, 49.7], [2.2, 61.2]];
const DISTRICTS = ["LU1", "LU2", "LU3", "LU4", "LU5", "LU6", "LU7"];

async function plannedArea() {
  const response = await fetch("/assets/lu-districts.geojson");
  if (!response.ok) throw new Error(`Coverage data returned ${response.status}`);
  const data = await response.json();
  const features = data.features.filter((feature) => feature.properties?.highlighted === true);
  const names = features.map((feature) => feature.properties.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(DISTRICTS)) throw new Error("Planned coverage data is incomplete");
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({ type: "Feature", properties: {}, geometry: feature.geometry })),
  };
}

function showMessage(message, text) {
  message.textContent = text;
  message.hidden = false;
}

function initializeCoverageMap() {
  const container = document.getElementById("coverage-map");
  const message = document.getElementById("map-message");
  const reset = document.getElementById("map-reset");
  if (!container || !message || !reset) return;

  try {
    setWorkerUrl("/assets/maplibre-gl-worker.mjs");
    const map = new Map({
      container,
      style: STYLE_URL,
      center: [-2.4, 54.5],
      zoom: 4.5,
      minZoom: 3.5,
      maxZoom: 17,
      cooperativeGestures: true,
      dragRotate: false,
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.touchZoomRotate.disableRotation();

    const showUK = () => map.fitBounds(UK_BOUNDS, { padding: 24, duration: 0, maxZoom: 5.5 });
    reset.addEventListener("click", showUK);
    const slowLoad = setTimeout(() => showMessage(message, "The map is taking longer than expected to load."), 15000);

    map.on("load", async () => {
      clearTimeout(slowLoad);
      showUK();
      try {
        const data = await plannedArea();
        const firstLabel = map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
        map.addSource("planned-launch-area", { type: "geojson", data });
        map.addLayer({
          id: "planned-launch-fill",
          type: "fill",
          source: "planned-launch-area",
          paint: {
            "fill-color": "#1261d5",
            "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0.8, 8, 0.55, 14, 0.38],
            "fill-antialias": false,
          },
        }, firstLabel);
        map.addLayer({
          id: "planned-launch-outline",
          type: "line",
          source: "planned-launch-area",
          paint: {
            "line-color": "#074ba8",
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.95, 7, 0],
            "line-width": 4,
          },
        }, firstLabel);
        message.hidden = true;
        container.dataset.coverageReady = "true";
      } catch (error) {
        showMessage(message, "The map is available, but the planned area could not be displayed.");
        console.error("Coverage overlay unavailable", error);
      }
    });
    map.on("error", (event) => {
      if (!map.isStyleLoaded()) showMessage(message, "The map is temporarily unavailable. Please try again later.");
      console.error("UK map unavailable", event.error);
    });
  } catch (error) {
    showMessage(message, "The map is temporarily unavailable. Please try again later.");
    console.error("UK map unavailable", error);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeCoverageMap, { once: true });
else initializeCoverageMap();
