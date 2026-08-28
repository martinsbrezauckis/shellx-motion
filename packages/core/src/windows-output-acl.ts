/**
 * Windows DACL admission for caller-selected output routes.
 *
 * Node exposes directory identity on Windows but not the DACL that decides which principals can
 * replace a child through that directory.  The static PowerShell query below reads the raw DACL
 * as SIDs and access masks; no caller ACL is changed.  Unsupported or unreadable descriptors are
 * refusals because a portable pathname recheck cannot make their authority safe.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveWindowsSystemExecutable } from "./windows-system-executable";

const execFileAsync = promisify(execFile);
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
const CREATOR_OWNER_SID = "S-1-3-0";
// Windows commonly owns the volume root through this one fixed service SID. It is privileged OS
// infrastructure, not an arbitrary service account; other service and unresolved SIDs stay denied.
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const ACE_FLAG_OBJECT_INHERIT = 0x01;
const ACE_FLAG_CONTAINER_INHERIT = 0x02;
const ACE_FLAG_INHERIT_ONLY = 0x08;
const FILE_ADD_FILE = 0x0002;
const FILE_ADD_SUBDIRECTORY = 0x0004;
const FILE_DELETE_CHILD = 0x0040;
const DELETE = 0x0001_0000;
const WRITE_DAC = 0x0004_0000;
const WRITE_OWNER = 0x0008_0000;
const MAXIMUM_ALLOWED = 0x0200_0000;
const GENERIC_ALL = 0x1000_0000;
const GENERIC_WRITE = 0x4000_0000;
const ALWAYS_DANGEROUS = FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | MAXIMUM_ALLOWED | GENERIC_ALL;
const CHILD_WRITE_DANGEROUS = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | GENERIC_WRITE;

export interface WindowsOutputAclAce {
  type: string;
  sid: string | null;
  accessMask: number;
  aceFlags: number;
}

export interface WindowsOutputAclSnapshot {
  currentSid: string;
  ownerSid: string | null;
  daclPresent: boolean;
  daclProtected: boolean;
  aces: WindowsOutputAclAce[];
}

export interface WindowsOutputAclAuthorityRequest {
  path: string;
  requiresChildWrite: boolean;
}

export class WindowsOutputAclError extends Error {
  constructor(message: string, readonly path?: string) {
    super(message);
    this.name = "WindowsOutputAclError";
    Object.setPrototypeOf(this, WindowsOutputAclError.prototype);
  }
}

/** Inspect and conservatively admit one already-existing output route directory on Windows. */
export async function assertWindowsOutputDirectoryAuthority(path: string, options: { requiresChildWrite: boolean }): Promise<void> {
  await assertWindowsOutputDirectoryAuthorities([{ path, requiresChildWrite: options.requiresChildWrite }]);
}

/** Inspect one complete route in a single native query, then evaluate every directory independently. */
export async function assertWindowsOutputDirectoryAuthorities(requests: readonly WindowsOutputAclAuthorityRequest[]): Promise<void> {
  if (process.platform !== "win32" || requests.length === 0) return;
  const snapshots = await inspectWindowsOutputAcls(requests.map(({ path }) => path));
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const refusal = evaluateWindowsOutputAcl(snapshots[index]!, { requiresChildWrite: request.requiresChildWrite });
    if (refusal) throw new WindowsOutputAclError(refusal, request.path);
  }
}

/**
 * Determine whether a raw Windows DACL gives any non-trusted principal output-replacement power.
 * Windows combines token group SIDs, so a per-SID deny/allow walk is not an authority proof (for
 * example, a deny for Everyone and allow for Authenticated Users). Without a native Authz query
 * for every possible distinct principal, any dangerous untrusted allow is a conservative refusal.
 * Inherit-only ACEs do not apply to the current directory, but when Motion will create children
 * they must be evaluated as the permissions inherited by those stage, lock, and destination children.
 */
export function evaluateWindowsOutputAcl(snapshot: WindowsOutputAclSnapshot, options: { requiresChildWrite: boolean }): string | null {
  if (!validSnapshot(snapshot)) return "Windows output DACL inspection returned malformed authority data.";
  if (!snapshot.daclPresent) return "Windows output directory has a null DACL that grants every principal full control.";
  if (!isTrustedSid(snapshot.ownerSid, snapshot.currentSid)) {
    return "Windows output directory is owned by an unrelated principal that can rewrite its DACL.";
  }

  for (const ace of snapshot.aces) {
    const kind = accessKind(ace.type);
    if (!kind || !ace.sid || !safeSid(ace.sid) || !Number.isSafeInteger(ace.accessMask) || !Number.isSafeInteger(ace.aceFlags)) {
      return "Windows output DACL contains an unsupported or unresolved ACE.";
    }
    const sid = ace.sid.toUpperCase();
    const mask = ace.accessMask >>> 0;
    if (kind === "allow" && (ace.aceFlags & ACE_FLAG_INHERIT_ONLY) === 0 && !isTrustedSid(sid, snapshot.currentSid)) {
      const dangerousMask = ALWAYS_DANGEROUS | (options.requiresChildWrite ? CHILD_WRITE_DANGEROUS : 0);
      if ((mask & dangerousMask) !== 0) {
        return `Windows output DACL grants an unrelated principal (${sid}) write, rename, delete, or child-creation authority.`;
      }
    }
    if (!options.requiresChildWrite || kind !== "allow" || isChildInheritedTrustedSid(sid, snapshot.currentSid)) continue;
    if ((ace.aceFlags & ACE_FLAG_OBJECT_INHERIT) !== 0 && (mask & (ALWAYS_DANGEROUS | CHILD_WRITE_DANGEROUS)) !== 0) {
      return `Windows output DACL grants an unrelated principal (${sid}) inherited write authority over Motion-created files.`;
    }
    if ((ace.aceFlags & ACE_FLAG_CONTAINER_INHERIT) !== 0 && (mask & (ALWAYS_DANGEROUS | CHILD_WRITE_DANGEROUS)) !== 0) {
      return `Windows output DACL grants an unrelated principal (${sid}) inherited write authority over Motion-created directories.`;
    }
  }
  return null;
}

async function inspectWindowsOutputAcls(paths: readonly string[]): Promise<WindowsOutputAclSnapshot[]> {
  try {
    const { stdout } = await execFileAsync(resolveWindowsSystemExecutable("powershell"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_OUTPUT_ACL_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SHELLX_MOTION_OUTPUT_ACL_PATHS: JSON.stringify(paths) }
    });
    return parseWindowsOutputAclSnapshots(stdout, paths.length);
  } catch (error) {
    if (error instanceof WindowsOutputAclError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WindowsOutputAclError(`Windows output DACL could not be inspected safely (${message}).`);
  }
}

export function parseWindowsOutputAclSnapshots(raw: string, expectedCount: number): WindowsOutputAclSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
    if (!Array.isArray(parsed) || parsed.length !== expectedCount || parsed.length > 1_024) {
      throw new Error("unexpected ACL result count");
    }
    return parsed.map(parseWindowsOutputAclSnapshotValue);
  } catch (error) {
    if (error instanceof WindowsOutputAclError) throw error;
    throw new WindowsOutputAclError("Windows output DACL inspection returned invalid JSON.");
  }
}

export function parseWindowsOutputAclSnapshot(raw: string): WindowsOutputAclSnapshot {
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
    return parseWindowsOutputAclSnapshotValue(parsed);
  } catch {
    throw new WindowsOutputAclError("Windows output DACL inspection returned invalid JSON.");
  }
}

function parseWindowsOutputAclSnapshotValue(parsed: unknown): WindowsOutputAclSnapshot {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an ACL object");
  const currentSid = Reflect.get(parsed, "currentSid");
  const ownerSid = Reflect.get(parsed, "ownerSid");
  const daclPresent = Reflect.get(parsed, "daclPresent");
  const daclProtected = Reflect.get(parsed, "daclProtected");
  const aces = Reflect.get(parsed, "aces");
  if (typeof currentSid !== "string"
    || (ownerSid !== null && typeof ownerSid !== "string")
    || typeof daclPresent !== "boolean"
    || typeof daclProtected !== "boolean"
    || !Array.isArray(aces)
    || aces.length > 1_024) {
    throw new Error("malformed ACL fields");
  }
  return {
    currentSid,
    ownerSid,
    daclPresent,
    daclProtected,
    aces: aces.map(parseWindowsOutputAclAce)
  };
}

function parseWindowsOutputAclAce(value: unknown): WindowsOutputAclAce {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed ACE");
  const type = Reflect.get(value, "type");
  const sid = Reflect.get(value, "sid");
  const accessMask = Reflect.get(value, "accessMask");
  const aceFlags = Reflect.get(value, "aceFlags");
  if (typeof type !== "string"
    || (sid !== null && typeof sid !== "string")
    || typeof accessMask !== "number"
    || !Number.isSafeInteger(accessMask)
    || typeof aceFlags !== "number"
    || !Number.isSafeInteger(aceFlags)) {
    throw new Error("malformed ACE fields");
  }
  return { type, sid, accessMask, aceFlags };
}

function accessKind(type: string): "allow" | "deny" | null {
  if (type === "AccessAllowed") return "allow";
  if (type === "AccessDenied") return "deny";
  return null;
}

function isTrustedSid(sid: string | null, currentSid: string): boolean {
  if (!sid) return false;
  const normalized = sid.toUpperCase();
  return normalized === currentSid.toUpperCase()
    || normalized === SYSTEM_SID
    || normalized === ADMINISTRATORS_SID
    || normalized === TRUSTED_INSTALLER_SID;
}

function isChildInheritedTrustedSid(sid: string, currentSid: string): boolean {
  // CREATOR OWNER is only safe here: Windows substitutes the SID of the process that creates the
  // immediate child. It is never accepted as authority over the already-existing directory.
  return isTrustedSid(sid, currentSid) || sid.toUpperCase() === CREATOR_OWNER_SID;
}

function safeSid(value: string): boolean {
  return /^S-\d+(?:-\d+)+$/i.test(value) && value.length <= 256;
}

function validSnapshot(snapshot: WindowsOutputAclSnapshot): boolean {
  return safeSid(snapshot.currentSid)
    && (snapshot.ownerSid === null || safeSid(snapshot.ownerSid))
    && typeof snapshot.daclPresent === "boolean"
    && typeof snapshot.daclProtected === "boolean"
    && snapshot.aces.length <= 1_024;
}

const WINDOWS_OUTPUT_ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner",
  "$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$paths=ConvertFrom-Json -InputObject $env:SHELLX_MOTION_OUTPUT_ACL_PATHS",
  "$results=@()",
  "foreach($path in @($paths)){$item=Get-Item -LiteralPath $path -Force;if(-not $item.PSIsContainer){throw 'Output ACL target is not a directory'};$security=$item.GetAccessControl($sections);$raw=New-Object Security.AccessControl.RawSecurityDescriptor($security.GetSecurityDescriptorBinaryForm(),0);$aces=@();if($null -ne $raw.DiscretionaryAcl){foreach($ace in $raw.DiscretionaryAcl){$qualified=$ace -as [Security.AccessControl.QualifiedAce];$aces+=[pscustomobject]@{type=$ace.AceType.ToString();sid=if($null -eq $qualified){$null}else{$qualified.SecurityIdentifier.Value};accessMask=if($null -eq $qualified){0}else{[int64]$qualified.AccessMask};aceFlags=[int]$ace.AceFlags}}};$owner=$security.GetOwner([Security.Principal.SecurityIdentifier]);$results+=[pscustomobject]@{currentSid=$currentSid;ownerSid=if($null -eq $owner){$null}else{$owner.Value};daclPresent=($null -ne $raw.DiscretionaryAcl);daclProtected=$security.AreAccessRulesProtected;aces=$aces}}",
  "ConvertTo-Json -InputObject @($results) -Compress -Depth 4"
].join("; ");
