import { describe, expect, it } from "vitest";

import {
  evaluateWindowsOutputAcl,
  parseWindowsOutputAclSnapshot,
  parseWindowsOutputAclSnapshots,
  type WindowsOutputAclSnapshot,
} from "./windows-output-acl";

const currentSid = "S-1-5-21-1000-1000-1000-1001";

function snapshot(
  overrides: Partial<WindowsOutputAclSnapshot> = {},
): WindowsOutputAclSnapshot {
  return {
    currentSid,
    ownerSid: currentSid,
    daclPresent: true,
    daclProtected: true,
    aces: [
      { type: "AccessAllowed", sid: currentSid, accessMask: 0x1f01ff, aceFlags: 0 },
      { type: "AccessAllowed", sid: "S-1-5-18", accessMask: 0x1f01ff, aceFlags: 0 },
      { type: "AccessAllowed", sid: "S-1-5-32-544", accessMask: 0x1f01ff, aceFlags: 0 },
    ],
    ...overrides,
  };
}

describe("evaluateWindowsOutputAcl", () => {
  it("accepts a protected private user DACL", () => {
    expect(evaluateWindowsOutputAcl(snapshot(), { requiresChildWrite: true })).toBeNull();
  });

  it("rejects a broad principal allowed to create children at a destination parent", () => {
    const refusal = evaluateWindowsOutputAcl(
      snapshot({
        aces: [
          ...snapshot().aces,
          { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
        ],
      }),
      { requiresChildWrite: true },
    );

    expect(refusal).toContain("S-1-5-11");
  });

  it("allows child-creation rights on an ancestor that cannot modify the existing route", () => {
    expect(
      evaluateWindowsOutputAcl(
        snapshot({
          aces: [
            ...snapshot().aces,
            { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
          ],
        }),
        { requiresChildWrite: false },
      ),
    ).toBeNull();
  });

  it("does not treat a deny as proof that an untrusted allow is safe", () => {
    const deniedFirst = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessDenied", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
        { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
      ],
    });
    const allowedFirst = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
        { type: "AccessDenied", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
      ],
    });

    expect(evaluateWindowsOutputAcl(deniedFirst, { requiresChildWrite: true })).toContain("S-1-5-11");
    expect(evaluateWindowsOutputAcl(allowedFirst, { requiresChildWrite: true })).toContain("S-1-5-11");
  });

  it("evaluates inherit-only OI/CI ACEs when Motion will create children", () => {
    const inheritOnly = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0x0b },
      ],
    });
    const inherited = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0x10 },
      ],
    });

    expect(evaluateWindowsOutputAcl(inheritOnly, { requiresChildWrite: false })).toBeNull();
    expect(evaluateWindowsOutputAcl(inheritOnly, { requiresChildWrite: true })).toContain("inherited write authority");
    expect(evaluateWindowsOutputAcl(inherited, { requiresChildWrite: true })).toContain("S-1-5-11");
  });

  it("rejects inherit-only broad write authority that will flow to Motion-created children", () => {
    const childWrite = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x40000000, aceFlags: 0x0b },
      ],
    });
    const childDelete = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessAllowed", sid: "S-1-5-11", accessMask: 0x00010000, aceFlags: 0x0b },
      ],
    });

    expect(evaluateWindowsOutputAcl(childWrite, { requiresChildWrite: true })).toContain("inherited write authority");
    expect(evaluateWindowsOutputAcl(childDelete, { requiresChildWrite: true })).toContain("inherited write authority");
  });

  it("allows inherit-only CREATOR OWNER only for Motion-created children", () => {
    const creatorOwner = snapshot({
      aces: [
        ...snapshot().aces,
        { type: "AccessAllowed", sid: "S-1-3-0", accessMask: 0x1f01ff, aceFlags: 0x0b },
      ],
    });

    expect(evaluateWindowsOutputAcl(creatorOwner, { requiresChildWrite: true })).toBeNull();
  });

  it("fails closed for a null DACL, unrelated owner, unresolved SID, and unknown ACE", () => {
    expect(evaluateWindowsOutputAcl(snapshot({ daclPresent: false }), { requiresChildWrite: true })).toContain(
      "null DACL",
    );
    expect(
      evaluateWindowsOutputAcl(snapshot({ ownerSid: "S-1-5-21-1000-1000-1000-2002" }), {
        requiresChildWrite: true,
      }),
    ).toContain("owned by an unrelated principal");
    expect(
      evaluateWindowsOutputAcl(
        snapshot({
          aces: [
            ...snapshot().aces,
            { type: "AccessAllowed", sid: null, accessMask: 0x0004, aceFlags: 0 },
          ],
        }),
        { requiresChildWrite: true },
      ),
    ).toContain("unresolved");
    expect(
      evaluateWindowsOutputAcl(
        snapshot({
          aces: [
            ...snapshot().aces,
            { type: "SystemAudit", sid: "S-1-5-11", accessMask: 0x0004, aceFlags: 0 },
          ],
        }),
        { requiresChildWrite: true },
      ),
    ).toContain("unsupported");
  });
});

describe("parseWindowsOutputAclSnapshot", () => {
  it("accepts the exact typed PowerShell payload", () => {
    expect(parseWindowsOutputAclSnapshot(JSON.stringify(snapshot()))).toEqual(snapshot());
  });

  it.each([
    { ...snapshot(), currentSid: 7 },
    { ...snapshot(), daclPresent: "true" },
    { ...snapshot(), aces: [null] },
    { ...snapshot(), aces: [{ ...snapshot().aces[0], accessMask: "4" }] },
  ])("rejects malformed dynamic ACL data without coercion", (value) => {
    expect(() => parseWindowsOutputAclSnapshot(JSON.stringify(value))).toThrow(
      "Windows output DACL inspection returned invalid JSON.",
    );
  });

  it("preserves ordered batched route snapshots and rejects a truncated result", () => {
    const second = snapshot({ daclProtected: false });
    expect(parseWindowsOutputAclSnapshots(JSON.stringify([snapshot(), second]), 2)).toEqual([snapshot(), second]);
    expect(() => parseWindowsOutputAclSnapshots(JSON.stringify([snapshot()]), 2)).toThrow(
      "Windows output DACL inspection returned invalid JSON.",
    );
  });
});
