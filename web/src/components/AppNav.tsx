"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarCheck, KeyRound, LayoutGrid, ListChecks, Workflow } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

/**
 * The one place every surface is reachable from.
 *
 * Until now the board, Today, the runs dashboard and the secrets page were
 * only reachable by typing a URL or through whichever ad-hoc link a given page
 * happened to carry — which meant most of the product was, in practice,
 * undiscoverable.
 *
 * The board comes first because it is the default route and the daily driver
 * (docs/BOARD.md); the canvas comes last because it is configuration.
 */

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Also treat these prefixes as "here", so a detail page keeps its tab lit. */
  match?: (pathname: string) => boolean;
}

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Board",
    icon: LayoutGrid,
    match: (pathname) => pathname === "/",
  },
  { href: "/today", label: "Today", icon: CalendarCheck },
  {
    href: "/runs",
    label: "Runs",
    icon: ListChecks,
    match: (pathname) => pathname.startsWith("/runs"),
  },
  {
    href: "/pipelines",
    label: "Pipelines",
    icon: Workflow,
    match: (pathname) => pathname.startsWith("/pipelines"),
  },
  {
    href: "/settings/secrets",
    label: "Secrets",
    icon: KeyRound,
    match: (pathname) => pathname.startsWith("/settings"),
  },
];

export function AppNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      data-testid="app-nav"
      aria-label="Main"
      className="flex shrink-0 items-center gap-1 border-b bg-background px-3 py-1.5"
    >
      <span className="mr-2 text-sm font-semibold tracking-tight select-none">AgentFlow</span>

      {ITEMS.map((item) => {
        const active = item.match ? item.match(pathname) : pathname.startsWith(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            data-testid={`nav-${item.label.toLowerCase()}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
              active
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
