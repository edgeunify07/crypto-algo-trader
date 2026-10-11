import type { MetadataRoute } from "next";

/**
 * PWA manifest. `display: "standalone"` is what makes iOS open the app
 * chrome-free once it is added to the Home Screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Algo Futures Trader",
    short_name: "Algo",
    description:
      "Automated multi-timeframe crypto futures paper trading with Elliott Wave and Gann analysis.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0d13",
    theme_color: "#0a0d13",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
