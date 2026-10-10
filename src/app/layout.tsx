import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Algo Futures",
  description:
    "Automated multi-timeframe crypto futures paper trading with Elliott Wave and Gann analysis.",
  // iOS reads these to run the app full-screen from the Home Screen.
  appleWebApp: {
    capable: true,
    title: "Algo",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0d13",
  width: "device-width",
  initialScale: 1,
  // `viewportFit: cover` is required for the safe-area insets to resolve to
  // real values on notched iPhones; without it they are always 0.
  viewportFit: "cover",
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
