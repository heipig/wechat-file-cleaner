/**
 * MFT enumeration helper, executed by a plain Node.js runtime.
 *
 * Why this exists
 * ---------------
 * Electron 33 bundles Node 20, whose fs layer opens `\\.\D:` as a DIRECTORY:
 * the handle opens, `fstat` reports isDirectory, and every `readSync` fails with
 * EISDIR. Node 22+ fixed raw-volume handle handling. So the same MFT code that
 * works under the system `node.exe` (24.x) fails inside Electron's main process.
 *
 * Rather than pin the whole app to a runtime detail, the app asks a `node.exe`
 * child process to do the raw-volume work and reads its output. The protocol is
 * newline-delimited JSON so results can be streamed without buffering the whole
 * MFT in memory twice.
 *
 * Emitted lines:
 *   {"t":"boot",   ...geometry}                       once per volume
 *   {"t":"volume", "volume":"D", "records":N, ...}    once per volume, at the end
 *   {"t":"rec",    "r":recordNumber, "p":parentIndex, "n":name,
 *                  "z":size, "m":mtimeMs, "d":isDirectory}
 *   {"t":"error",  "volume":"D", "message":"..."}     on a volume-level failure
 *   {"t":"done",   "recordsEmitted":N, "elapsedMs":N}
 *
 * Read-only: it never writes to the volume.
 *
 * Usage: node tools/mft-helper.mjs D [E ...]
 */
import { enumerateMft } from '../src/mft/ntfs.js';

const volumes = process.argv.slice(2).filter((a) => /^[A-Za-z]$/.test(a));
if (!volumes.length) {
  process.stdout.write(`${JSON.stringify({ t: 'error', message: 'no volumes requested' })}\n`);
  process.exit(2);
}

/** Write one JSON line, ignoring EPIPE when the parent goes away. */
function emit(obj) {
  try {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* parent closed the pipe; the process will exit shortly */
  }
}

let totalEmitted = 0;
const started = Date.now();

for (const volume of volumes) {
  try {
    const summary = enumerateMft(volume, (batch, progress) => {
      for (const rec of batch) {
        const size = rec.isDirectory ? 0 : (rec.dataSize >= 0 ? rec.dataSize : rec.realSize);
        emit({
          t: 'rec',
          r: rec.recordNumber,
          p: rec.parent,
          n: rec.name,
          z: size,
          m: rec.modifiedMs,
          d: rec.isDirectory ? 1 : 0,
        });
      }
      totalEmitted += batch.length;
      emit({ t: 'progress', volume, recordsRead: progress.recordsRead, totalRecords: progress.totalRecords, kept: totalEmitted });
    }, { chunkRecords: 65536 });

    emit({
      t: 'volume',
      volume,
      records: totalEmitted,
      elapsedMs: summary.elapsedMs,
      mftBytes: summary.mftBytes,
      boot: {
        bytesPerSector: summary.boot.bytesPerSector,
        clusterSize: summary.boot.clusterSize,
        recordSize: summary.boot.recordSize,
        mftCluster: summary.boot.mftCluster,
      },
    });
  } catch (err) {
    emit({
      t: 'error',
      volume,
      message: err?.message ?? String(err),
      code: err?.code,
      name: err?.name,
    });
  }
}

emit({ t: 'done', recordsEmitted: totalEmitted, elapsedMs: Date.now() - started });
process.exit(0);
