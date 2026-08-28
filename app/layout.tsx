import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alerte cantine",
  description:
    "Rappelle aux parents de reserver la cantine avant l'echeance du portail, pour ne plus rater une semaine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
