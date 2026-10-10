import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pricing Lab",
  description: "Price, promotion and free-delivery scenarios for a grocery shelf, with the uncertainty shown.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
