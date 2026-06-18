import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Data Governance Agent Team",
  description:
    "An operational control plane of LLM agents, each bound by a declarative contract, evaluating data changes against policy.",
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
