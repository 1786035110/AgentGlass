import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export type StableFileReadFailure =
  | "missing"
  | "unsupported"
  | "too_large"
  | "grew_over_limit"
  | "changed"
  | "unreadable";

export class StableFileReadError extends Error {
  constructor(readonly code: StableFileReadFailure) {
    super(code);
  }
}

export interface StableFileRead {
  bytes: Buffer;
  stats: Awaited<ReturnType<typeof lstat>>;
  identity: Readonly<{ device: string; inode: string }>;
  mode: number;
  uid: string;
  gid: string;
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function mapReadError(error: unknown): StableFileReadError {
  if (error instanceof StableFileReadError) return error;
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOENT") return new StableFileReadError("missing");
  }
  return new StableFileReadError("unreadable");
}

export async function readStableFile(
  targetPath: string,
  limitBytes: number,
): Promise<StableFileRead> {
  try {
    const before = await lstat(targetPath);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
      throw new StableFileReadError("unsupported");
    if (before.size > limitBytes) throw new StableFileReadError("too_large");

    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(targetPath, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened))
        throw new StableFileReadError("changed");

      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        // 初始 stat 未超限也不能放过读取过程中增长的文件；超限后不继续分配内存。
        if (total > limitBytes)
          throw new StableFileReadError("grew_over_limit");
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }

      const after = await handle.stat();
      if (
        !sameFile(opened, after) ||
        after.size !== total ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        after.mode !== opened.mode
      ) {
        throw new StableFileReadError("changed");
      }
      return Object.freeze({
        bytes: Buffer.concat(chunks, total),
        stats: after,
        identity: Object.freeze({
          device: String(after.dev),
          inode: String(after.ino),
        }),
        mode: Number(after.mode),
        uid: String(after.uid),
        gid: String(after.gid),
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw mapReadError(error);
  }
}
