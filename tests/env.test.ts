/**
 * env.ts unit tests — read helpers + snapshot semantics.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readString, readInt, readBool, snapshotEnv, EnvSnapshot } from "../src/utils/env.js";

describe("env.readString", () => {
  test("returns process.env value when set", () => {
    process.env.OC_TEST_KEY = "hello";
    expect(readString("OC_TEST_KEY")).toBe("hello");
    delete process.env.OC_TEST_KEY;
  });

  test("returns fallback when unset", () => {
    delete process.env.OC_TEST_KEY_MISSING;
    expect(readString("OC_TEST_KEY_MISSING", "default")).toBe("default");
  });

  test("treats empty string as unset", () => {
    process.env.OC_TEST_KEY_EMPTY = "";
    expect(readString("OC_TEST_KEY_EMPTY", "fallback")).toBe("fallback");
    delete process.env.OC_TEST_KEY_EMPTY;
  });
});

describe("env.readInt", () => {
  test("parses valid integer", () => {
    process.env.OC_TEST_INT = "42";
    expect(readInt("OC_TEST_INT", 0)).toBe(42);
    delete process.env.OC_TEST_INT;
  });

  test("returns fallback for invalid input", () => {
    process.env.OC_TEST_INT_BAD = "not-a-number";
    expect(readInt("OC_TEST_INT_BAD", 99)).toBe(99);
    delete process.env.OC_TEST_INT_BAD;
  });

  test("returns fallback when unset", () => {
    delete process.env.OC_TEST_INT_MISSING;
    expect(readInt("OC_TEST_INT_MISSING", 7)).toBe(7);
  });
});

describe("env.readBool", () => {
  test("recognizes truthy variants", () => {
    for (const v of ["1", "true", "TRUE", "yes", "YES"]) {
      process.env.OC_TEST_BOOL = v;
      expect(readBool("OC_TEST_BOOL")).toBe(true);
    }
    delete process.env.OC_TEST_BOOL;
  });

  test("recognizes falsy variants", () => {
    for (const v of ["0", "false", "FALSE", "no", "NO"]) {
      process.env.OC_TEST_BOOL = v;
      expect(readBool("OC_TEST_BOOL")).toBe(false);
    }
    delete process.env.OC_TEST_BOOL;
  });

  test("returns fallback for unrecognized values", () => {
    process.env.OC_TEST_BOOL = "maybe";
    expect(readBool("OC_TEST_BOOL", true)).toBe(true);
    expect(readBool("OC_TEST_BOOL", false)).toBe(false);
    delete process.env.OC_TEST_BOOL;
  });
});

describe("env.snapshotEnv", () => {
  beforeEach(() => {
    delete process.env.OC_SNAP_A;
    delete process.env.OC_SNAP_B;
    delete process.env.OC_SNAP_C;
  });

  test("captures pre-set values and restores them", () => {
    process.env.OC_SNAP_A = "before";
    const snap = snapshotEnv(["OC_SNAP_A", "OC_SNAP_B"]);
    process.env.OC_SNAP_A = "during";
    process.env.OC_SNAP_B = "added";
    snap.restore();
    expect(process.env.OC_SNAP_A).toBe("before");
    expect(process.env.OC_SNAP_B).toBeUndefined();
  });

  test("captures set value and restores it even after delete during test", () => {
    process.env.OC_SNAP_C = "captured-value";
    const snap = snapshotEnv(["OC_SNAP_C"]);
    delete process.env.OC_SNAP_C; // mutate during test
    expect(process.env.OC_SNAP_C).toBeUndefined();
    snap.restore();
    expect(process.env.OC_SNAP_C as string | undefined).toBe("captured-value");
  });
});

describe("env.EnvSnapshot", () => {
  afterEach(() => {
    delete process.env.OC_SNAP_ALL_A;
    delete process.env.OC_SNAP_ALL_B;
  });

  test("captures entire env and restores including deletions", () => {
    process.env.OC_SNAP_ALL_A = "1";
    const snap = new EnvSnapshot();
    process.env.OC_SNAP_ALL_A = "2";
    process.env.OC_SNAP_ALL_B = "newly-added";
    snap.restore();
    expect(process.env.OC_SNAP_ALL_A).toBe("1");
    expect(process.env.OC_SNAP_ALL_B).toBeUndefined();
  });
});