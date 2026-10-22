import Link from "next/link";
export default function NotFound() {
  return (
    <main className="initial-loading">
      <h1>페이지를 찾지 못했습니다</h1>
      <p>주소를 확인하거나 검색 화면으로 이동해 주세요.</p>
      <Link
        href="/"
        className="rounded-md bg-primary px-5 py-2 text-primary-foreground"
      >
        검색 화면으로 이동
      </Link>
    </main>
  );
}
