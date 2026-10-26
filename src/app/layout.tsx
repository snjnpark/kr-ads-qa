import type { Metadata } from "next";
import AppShell from "@/features/shell/AppShell";
import NavigationGuard from "@/components/NavigationGuard";
import "./globals.css";
export const metadata: Metadata = {
  title: "kr-ads-qa · 광고 설정",
  description: "광고 설정을 브라우저에 저장하고 사용자 기기에서 검색·검수하세요.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <NavigationGuard />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
