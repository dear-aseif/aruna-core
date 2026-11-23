import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Aruna", template: "%s · Aruna" },
  description: "An AI assistant for small businesses.",
  applicationName: "Aruna",
  appleWebApp: { capable: true, title: "Aruna", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-ink antialiased">{children}</body>
    </html>
  );
}
