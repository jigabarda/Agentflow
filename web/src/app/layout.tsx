import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppNav } from "@/components/AppNav";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgentFlow",
  description: "Workflow management for daily dev work, where the workers are AI agents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      {/* `h-full` + `min-h-0` so the board can own the remaining height and
          scroll its columns horizontally without the page scrolling. */}
      <body className="flex h-full flex-col bg-background text-foreground">
        {/* Tooltips are used across the board and the editor; the provider has
            to sit above all of them. `delayDuration` is short because these
            label icons the user is already pointing at. */}
        <TooltipProvider delayDuration={200}>
          <AppNav />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </TooltipProvider>
      </body>
    </html>
  );
}
