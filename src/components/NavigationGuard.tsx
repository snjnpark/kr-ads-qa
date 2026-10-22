"use client";

import { useEffect } from "react";
import { installNavigationGuard } from "@/lib/navigation-guard";

export default function NavigationGuard() {
  useEffect(() => installNavigationGuard(window), []);
  return null;
}
