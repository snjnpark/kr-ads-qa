import type { Metadata } from "next";
import AppShell from "@/AppShell";
import NavigationGuard from "@/components/NavigationGuard";
import "./globals.css";
export const metadata: Metadata = {
  title: "kr-ads-qa · 광고 설정",
  description: "네 광고 매체의 설정을 한곳에서 검색하고 검수하세요.",
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
