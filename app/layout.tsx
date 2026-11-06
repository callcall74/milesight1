import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "주차 점유 현황3",
  description: "Milesight AI 카메라 주차 점유 대시보드",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
