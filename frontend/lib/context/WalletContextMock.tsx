"use client";

/**
 * WalletContext — single source of truth for the connected wallet address.
 *
 * Why a context instead of calling useWalletConnection() everywhere?
 * ─────────────────────────────────────────────────────────────────
 * • One connection object for the entire component tree — no duplicate wallet
 *   state across siblings.
 * • Eliminates prop-drilling: NotificationBell, ProfileHeader, and any
 *   future auth-gated UI all read from context, not from props passed through
 *   multiple intermediate layers.
 * • Replaces the hardcoded placeholder address in useCurrentUserAddress with
 *   the real connect/disconnect flow (issue #1406).
 * • Cache invalidation: on disconnect the SWR keys that include the address
 *   (notifications, profile) can be invalidated in one place.
 *
 * Usage
 * ─────
 *   // In app/layout.tsx — already wraps SWRProvider / NetworkGuardProvider:
 *   <WalletProvider>…</WalletProvider>
 *
 *   // In any client component:
 *   const { address, connect, disconnect, isConnecting, error } = useWallet();
 *
 *   // When only the address is needed (avoids re-rendering on isConnecting):
 *   const address = useWalletAddress();
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSWRConfig } from "swr";
import {
  useWalletConnection,
  type WalletConnectionState,
} from "@/lib/hooks/useWalletConnection";
import { useNetwork } from "@/lib/context/NetworkContext";

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * Exported so useCurrentUserAddress can consume it directly without going
 * through the barrel (avoids a circular import).
 */
export const WalletContext = createContext<WalletConnectionState | undefined>(
  undefined,
);
WalletContext.displayName = "WalletContext";

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWalletConnection();
  const { mutate } = useSWRConfig();
  const { network } = useNetwork();

  // Identity = network + address. Account-scoped cache entries are keyed by
  // this identity so data from one wallet/network is never reused for another.
  const identityKey = useMemo(
    () => `${network}:${wallet.address ?? ""}`,
    [network, wallet.address],
  );

  // Bumped on every identity transition so consumers can reset local
  // account-bound state (balances, history, pending UI) in one place.
  const generationRef = useRef(0);
  const prevIdentityRef = useRef<string>(identityKey);

  // On any identity change (connect, disconnect, account switch, network
  // switch) drop all cached account data so nothing from the previous
  // identity flashes or is reused.
  useEffect(() => {
    const prev = prevIdentityRef.current;
    if (prev !== identityKey) {
      generationRef.current += 1;
      // Clear every cached key — the simplest correct strategy. SWR will
      // refetch any key that is currently mounted.
      void mutate(() => true, undefined, { revalidate: false });
      prevIdentityRef.current = identityKey;
    }
  }, [identityKey, mutate]);

  // Wrap disconnect to also clear the cache immediately on user action,
  // without waiting for the useEffect to run on the next render cycle.
  const disconnect = useCallback(() => {
    wallet.disconnect();
    generationRef.current += 1;
    void mutate(() => true, undefined, { revalidate: false });
  }, [wallet, mutate]);

  // Keep the context value object reference stable when wallet state is
  // unchanged — prevents all consumers from re-rendering on unrelated updates.
  const value = useMemo<WalletConnectionState>(
    () => ({
      address: wallet.address,
      isConnecting: wallet.isConnecting,
      error: wallet.error,
      requiredNetworkLabel: wallet.requiredNetworkLabel,
      connect: wallet.connect,
      disconnect,
      clearError: wallet.clearError,
      identityKey,
      generation: generationRef.current,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      wallet.address,
      wallet.isConnecting,
      wallet.error,
      wallet.requiredNetworkLabel,
      wallet.connect,
      disconnect,
      wallet.clearError,
      identityKey,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/**
 * useWallet — full wallet state from context.
 *
 * Throws a descriptive error when called outside <WalletProvider> so
 * misconfiguration surfaces immediately in development.
 */
export function useWallet(): WalletConnectionState {
  const ctx = useContext(WalletContext);
  if (ctx === undefined) {
    throw new Error(
      "useWallet must be used within a <WalletProvider>. " +
        "Add <WalletProvider> to your root layout.",
    );
  }
  return ctx;
}

/**
 * useWalletAddress — returns only the connected address (or `undefined`).
 *
 * Prefer this over useWallet() in components that only need the address so
 * they skip re-renders triggered by `isConnecting` or `error` changes.
 */
export function useWalletAddress(): string | undefined {
  const { address } = useWallet();
  return address ?? undefined;
}

// Re-export the state type so consumers don't need to import from the hook.
export type { WalletConnectionState };

// ── Deterministic test mock ───────────────────────────────────────────────────

/**
 * Lifecycle phases a mocked wallet can be driven through by the accessibility
 * journey tests. Each phase maps to a deterministic, extension-free state so
 * focus restoration and live-region announcements can be asserted reliably.
 *
 *   idle       — no wallet connected
 *   connecting — connection in flight (spinner / aria-busy assertions)
 *   connected  — address available, ready to sign
 *   signing    — signature request pending (dialog focus assertions)
 *   signed     — signature produced successfully
 *   rejected   — user rejected the signature request
 *   error      — connection or signing failed
 *   recovered  — error cleared, wallet usable again
 */
export type MockWalletPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "signing"
  | "signed"
  | "rejected"
  | "error"
  | "recovered";

export interface MockWalletControls {
  /** Current deterministic phase. */
  phase: MockWalletPhase;
  /** Address exposed while connected (undefined otherwise). */
  address: string | undefined;
  /** Last signature produced by `sign`, if any. */
  signature: string | undefined;
  /** Drive the mock to an arbitrary phase. */
  setPhase: (phase: MockWalletPhase) => void;
  /** Simulate a successful connect. */
  connect: () => void;
  /** Simulate a disconnect back to `idle`. */
  disconnect: () => void;
  /** Simulate a pending signature request. */
  sign: () => void;
  /** Simulate the user rejecting the signature request. */
  reject: () => void;
  /** Simulate a failure. */
  fail: (message?: string) => void;
  /** Clear any error and return to a usable state. */
  recover: () => void;
}

export const MOCK_WALLET_ADDRESS =
  "0x000000000000000000000000000000000000dEaD";
export const MOCK_WALLET_SIGNATURE = "0x" + "ab".repeat(65);
export const MOCK_WALLET_ERROR = "Mock wallet error";

const MockWalletControlsContext = createContext<
  MockWalletControls | undefined
>(undefined);
MockWalletControlsContext.displayName = "MockWalletControlsContext";

/**
 * useMockWalletControls — access the deterministic mock driver.
 *
 * Only available inside <MockWalletProvider>; throws otherwise so tests fail
 * loudly if the mock is wired up incorrectly.
 */
export function useMockWalletControls(): MockWalletControls {
  const ctx = useContext(MockWalletControlsContext);
  if (ctx === undefined) {
    throw new Error(
      "useMockWalletControls must be used within a <MockWalletProvider>.",
    );
  }
  return ctx;
}

/**
 * MockWalletProvider — deterministic, extension-free replacement for
 * <WalletProvider> used by the accessibility journey tests.
 *
 * It exposes the same WalletContext contract as the real provider, so
 * components under test behave identically, while the connect / sign /
 * reject / fail / recover transitions are driven synchronously by the test.
 */
export function MockWalletProvider({
  children,
  initialPhase = "idle",
}: {
  children: ReactNode;
  initialPhase?: MockWalletPhase;
}) {
  const { mutate } = useSWRConfig();
  const { network } = useNetwork();

  const [phase, setPhaseState] = useState<MockWalletPhase>(initialPhase);
  const [signature, setSignature] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const address =
    phase === "idle" || phase === "connecting" || phase === "error"
      ? undefined
      : MOCK_WALLET_ADDRESS;

  const identityKey = useMemo(
    () => `${network}:${address ?? ""}`,
    [network, address],
  );

  const generationRef = useRef(0);
  const prevIdentityRef = useRef<string>(identityKey);

  useEffect(() => {
    const prev = prevIdentityRef.current;
    if (prev !== identityKey) {
      generationRef.current += 1;
      void mutate(() => true, undefined, { revalidate: false });
      prevIdentityRef.current = identityKey;
    }
  }, [identityKey, mutate]);

  const setPhase = useCallback((next: MockWalletPhase) => {
    setPhaseState(next);
    if (next === "signed") {
      setSignature(MOCK_WALLET_SIGNATURE);
    }
    if (next === "rejected") {
      setError("Signature request rejected");
    }
    if (next === "error") {
      setError(MOCK_WALLET_ERROR);
    }
    if (next === "recovered" || next === "connected" || next === "idle") {
      setError(undefined);
    }
  }, []);

  const connect = useCallback(() => {
    setPhaseState("connecting");
    setError(undefined);
    // Synchronous transition keeps the mock deterministic for tests.
    setPhaseState("connected");
  }, []);

  const disconnect = useCallback(() => {
    setPhaseState("idle");
    setSignature(undefined);
    setError(undefined);
    generationRef.current += 1;
    void mutate(() => true, undefined, { revalidate: false });
  }, [mutate]);

  const sign = useCallback(() => {
    setPhaseState("signing");
    setPhaseState("signed");
    setSignature(MOCK_WALLET_SIGNATURE);
  }, []);

  const reject = useCallback(() => {
    setPhaseState("rejected");
    setError("Signature request rejected");
  }, []);

  const fail = useCallback((message?: string) => {
    setPhaseState("error");
    setError(message ?? MOCK_WALLET_ERROR);
  }, []);

  const recover = useCallback(() => {
    setPhaseState("recovered");
    setError(undefined);
  }, []);

  const clearError = useCallback(() => {
    setError(undefined);
    setPhaseState((prev) => (prev === "error" ? "recovered" : prev));
  }, []);

  const value = useMemo<WalletConnectionState>(
    () => ({
      address,
      isConnecting: phase === "connecting",
      error,
      requiredNetworkLabel: undefined,
      connect,
      disconnect,
      clearError,
      identityKey,
      generation: generationRef.current,
    }),
    [
      address,
      phase,
      error,
      connect,
      disconnect,
      clearError,
      identityKey,
    ],
  );

  const controls = useMemo<MockWalletControls>(
    () => ({
      phase,
      address,
      signature,
      setPhase,
      connect,
      disconnect,
      sign,
      reject,
      fail,
      recover,
    }),
    [
      phase,
      address,
      signature,
      setPhase,
      connect,
      disconnect,
      sign,
      reject,
      fail,
      recover,
    ],
  );

  return (
    <MockWalletControlsContext.Provider value={controls}>
      <WalletContext.Provider value={value}>
        {children}
      </WalletContext.Provider>
    </MockWalletControlsContext.Provider>
  );
}
