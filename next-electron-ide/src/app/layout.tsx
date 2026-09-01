import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CodéNawabs',
  description: 'A minimal desktop IDE built with Next.js + Electron + Monaco',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
