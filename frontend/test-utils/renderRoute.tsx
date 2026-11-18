/**
 * Render helper for core-route component tests (#84).
 *
 * Wraps the component under test in the same providers the app mounts at the
 * root (SWR, wallet, toasts, live region) but with a *fresh, isolated SWR
 * cache per test* so state does not leak between cases. Also exposes helpers
 * for the two states that are hard to reach otherwise: holding a request open
 * (loading) and seeding a stale cache entry (partial data).
 */

import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { SWRConfig } from "swr";
import { WalletContext } from "@/lib/context/WalletContext";
import type { WalletConnectionState } from "@/lib/hooks/useWalletConnection";
import { LiveRegionProvider, ToastProvider } from "@/components/ui";
import { TEST_ADDRESS } from "./apiFixtures";

export interface RouteRenderOptions {
  /** Connected wallet address, or `null` for a disconnected session. */
  address?: string | null;
  /** Seed entries into the SWR cache before render (keyed by request URL). */
  swrFallback?: Record<string, unknown>;
  /**
   * Overrides merged into the deterministic wallet state. Use this to model
   * connecting/error states in accessibility journeys without touching the
   * network or timers.
   */
  wallet?: Partial<WalletConnectionState>;
}

/** A minimal but complete WalletConnectionState for tests. */
export function walletState(address: string | null): WalletConnectionState {
  return {
    address,
    isConnecting: false,
    error: null,
    requiredNetworkLabel: "Testnet",
    connect: async () => address,
    disconnect: () => {},
    clearError: () => {},
  };
}

/**
 * Build a deterministic wallet state for a journey: the base state above with
 * any overrides applied. `connect`/`disconnect`/`clearError` stay stable no-op
 * spies unless explicitly overridden.
 */
export function mockWalletState(
  address: string | null,
  overrides: Partial<WalletConnectionState> = {},
): WalletConnectionState {
  return { ...walletState(address), ...overrides };
}

function Providers({
  children,
  options,
}: {
  children: ReactNode;
  options: RouteRenderOptions;
}) {
  const { address = TEST_ADDRESS, swrFallback, wallet } = options;

  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: swrFallback,
        // Deterministic behaviour for tests: no retries, no dedupe window, and
        // no focus/reconnect revalidation firing outside our control.
        dedupingInterval: 0,
        errorRetryCount: 0,
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      }}
    >
      <WalletContext.Provider value={mockWalletState(address, wallet)}>
        <LiveRegionProvider>
          <ToastProvider>{children}</ToastProvider>
        </LiveRegionProvider>
      </WalletContext.Provider>
    </SWRConfig>
  );
}

/** Render a route component with all app providers and an isolated SWR cache. */
export function renderRoute(
  ui: ReactElement,
  options: RouteRenderOptions = {},
): RenderResult {
  return render(<Providers options={options}>{ui}</Providers>);
}

/**
 * Collect the text of every live region currently mounted. Live regions are
 * identified by their ARIA attributes (`aria-live`, `role="status"`,
 * `role="alert"`) so announcements can be asserted after an interaction.
 */
export function getLiveRegionText(container: HTMLElement = document.body): string[] {
  const regions = container.querySelectorAll<HTMLElement>(
    '[aria-live], [role="status"], [role="alert"]',
  );
  return Array.from(regions)
    .map((region) => (region.textContent ?? "").trim())
    .filter((text) => text.length > 0);
}

/**
 * Assert that a live region announced `expected` (substring match) within the
 * current DOM. Throws with the observed announcements for easier debugging.
 */
export function expectAnnouncement(expected: string | RegExp): void {
  const announcements = getLiveRegionText();
  const matched = announcements.some((text) =>
    typeof expected === "string" ? text.includes(expected) : expected.test(text),
  );
  if (!matched) {
    throw new Error(
      `Expected a live-region announcement matching ${String(expected)}. ` +
        `Observed announcements: ${JSON.stringify(announcements)}`,
    );
  }
}
