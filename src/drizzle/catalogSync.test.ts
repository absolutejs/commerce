import { describe, expect, it } from "bun:test";
import { catalogSyncIdentity } from "./catalogSync";

describe("catalog synchronization identity", () => {
  it("isolates account-scoped provider truth by source identity", () => {
    const first = catalogSyncIdentity(
      "customcat:project-a",
      "variant",
      "48146",
    );
    const second = catalogSyncIdentity(
      "customcat:project-b",
      "variant",
      "48146",
    );

    expect(first).not.toBe(second);
    expect(first).toBe(
      catalogSyncIdentity("customcat:project-a", "variant", "48146"),
    );
    expect(first.length).toBeLessThanOrEqual(200);
  });
});
