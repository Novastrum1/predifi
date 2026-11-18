import "@testing-library/jest-dom";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Mock matchMedia for jsdom
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// ---------------------------------------------------------------------------
// Deterministic wallet mocks for route-level accessibility journeys.
// These provide a stable, predictable wallet state so axe checks and
// keyboard-only journeys do not depend on real wallet extensions.
// ---------------------------------------------------------------------------
export const DEFAULT_WALLET_STATE = {
  connected: true,
  address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  network: "TESTNET",
  balance: "1000.0000000",
};

export const createWalletMock = (overrides = {}) => {
  const state = { ...DEFAULT_WALLET_STATE, ...overrides };
  return {
    ...state,
    connect: jest.fn(async () => state),
    disconnect: jest.fn(async () => ({ ...state, connected: false })),
    signTransaction: jest.fn(async (tx) => tx),
    getAddress: jest.fn(async () => state.address),
    getNetwork: jest.fn(async () => state.network),
    getBalance: jest.fn(async () => state.balance),
    reset: jest.fn(),
  };
};

// Install a deterministic wallet mock on the global scope unless one exists.
if (typeof global.walletMock === "undefined") {
  global.walletMock = createWalletMock();
}

// ---------------------------------------------------------------------------
// Live-region helpers.
// Route-level accessibility tests assert focus restoration and live-region
// announcements. These helpers reset live-region state between tests so
// assertions are reliable and do not leak across test cases.
// ---------------------------------------------------------------------------
export const LIVE_REGION_SELECTOR =
  '[role="status"], [role="alert"], [aria-live]';

export const resetLiveRegions = () => {
  if (typeof document === "undefined") return;
  const regions = document.querySelectorAll(LIVE_REGION_SELECTOR);
  regions.forEach((region) => {
    region.textContent = "";
    region.innerHTML = "";
  });
};

export const getLiveRegionText = () => {
  if (typeof document === "undefined") return "";
  const regions = document.querySelectorAll(LIVE_REGION_SELECTOR);
  return Array.from(regions)
    .map((region) => region.textContent || "")
    .join(" ")
    .trim();
};

export const resetFocusState = () => {
  if (typeof document === "undefined") return;
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
};

// Reset live-region and focus state before each test so focus restoration
// and announcement assertions start from a clean slate.
beforeEach(() => {
  resetLiveRegions();
  resetFocusState();
  global.walletMock = createWalletMock();
});

afterEach(() => {
  resetLiveRegions();
  resetFocusState();
  jest.clearAllMocks();
});