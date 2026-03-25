import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

const cairo = Cairo({ 
  subsets: ["arabic", "latin"],
  display: "swap",
  variable: "--font-cairo"
});

export const metadata: Metadata = {
  title: "Sheet2Social Control Center",
  description: "Professional automation dashboard for accounts, groups, posts, and workflow control.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr">
      <body className={`${cairo.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}