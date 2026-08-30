import { OutputDirectoryReservation } from "./output-path-topology";

/**
 * Lazily create and retain one owner-private runtime directory.
 *
 * Runtime stores are best-effort at their callers, but a usable store must never silently adopt a
 * symlink, an unrelated owner, or group/world-writable precreated state. The retained reservation
 * also detects replacement between later lease, record, and event operations.
 */
export class PrivateMotionRuntimeDirectory {
  private authority: Promise<OutputDirectoryReservation> | undefined;

  constructor(readonly path: string) {}

  async assertCurrent(): Promise<void> {
    const authority = await (this.authority ??= OutputDirectoryReservation.acquire(this.path, {
      allowExistingContents: true,
      requirePrivate: true
    }));
    await authority.assertCurrent();
  }
}
