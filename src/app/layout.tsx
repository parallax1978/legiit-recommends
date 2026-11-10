import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: { default: "Legiit Recommends", template: "%s · Legiit Recommends" },
  description:
    "Create and run repeatable AI conversation campaigns and measure recommendation changes over time.",
  applicationName: "Legiit Recommends",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#8a12dc",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
