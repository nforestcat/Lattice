import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (typeof window.confirm !== "function") {
  Object.defineProperty(window, "confirm", {
    value: () => true,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
});
