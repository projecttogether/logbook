import { afterEach, describe, expect, it } from "vitest";
import { envValue } from "./env";

describe("envValue", () => {
  afterEach(() => {
    delete process.env.LOGBOOK_TEST_SETTING;
  });

  it("treats unset and blank values as unset", () => {
    expect(envValue("LOGBOOK_TEST_SETTING")).toBeUndefined();
    process.env.LOGBOOK_TEST_SETTING = "  ";
    expect(envValue("LOGBOOK_TEST_SETTING")).toBeUndefined();
  });

  it("returns the trimmed value", () => {
    process.env.LOGBOOK_TEST_SETTING = " /tmp/heartbeat ";
    expect(envValue("LOGBOOK_TEST_SETTING")).toBe("/tmp/heartbeat");
  });
});
