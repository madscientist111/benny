import { log, type LogIds } from './log'

// The ustar writer and its stream builder. `archiveCheckout` (`checkout.ts`) walks a checkout and
// hands the entries over one at a time, so neither the tree nor a whole file is ever held in memory.

/** One path in the archive, with what a ustar header needs. */
export type TarEntry = {
    /** Path relative to the archive root: `src/bot.ts`, `.git/HEAD`. A directory gets no `/`. */
    path: string
    type: 'file' | 'directory'
    /** Seconds since the epoch, as ustar stores it. */
    mtime: number
    /** The file's byte count; 0 for a directory. */
    size: number
    /** The file's bytes. Absent for a directory. */
    read?: () => Promise<ReadableStream<Uint8Array>>
}

const BLOCK_BYTES = 512
const NAME_BYTES = 100
const PREFIX_BYTES = 155
const FILE_MODE = 0o644
const DIRECTORY_MODE = 0o755

// Field offsets in the 512-byte header. Every numeric field is octal digits then a NUL.
const MODE_OFFSET = 100
const UID_OFFSET = 108
const GID_OFFSET = 116
const SIZE_OFFSET = 124
const MTIME_OFFSET = 136
const CHECKSUM_OFFSET = 148
const TYPEFLAG_OFFSET = 156
const MAGIC_OFFSET = 257
const VERSION_OFFSET = 263
const PREFIX_OFFSET = 345

const TEXT_ENCODER = new TextEncoder()

/** Zero-padded octal digits in a field, then the NUL that ends it. */
const writeOctal = (header: Uint8Array, offset: number, digits: number, value: number) => {
    header.set(TEXT_ENCODER.encode(value.toString(8).padStart(digits, '0')), offset)
    header[offset + digits] = 0
}

/**
 * A path over 100 bytes is split into the 155-byte prefix field and the 100-byte name field.
 * `reservedBytes` is what the caller appends to the name, such as a directory's `/`.
 */
const splitPath = (path: string, reservedBytes: number): { name: string; prefix: string } | null => {
    const fitsName = (text: string) => TEXT_ENCODER.encode(text).length + reservedBytes <= NAME_BYTES
    if (fitsName(path)) return { name: path, prefix: '' }
    // From the right, so the name field keeps as little as possible: the last split that fits wins.
    for (let index = path.length - 1; index > 0; index -= 1) {
        if (path[index] !== '/') continue
        const name = path.slice(index + 1)
        if (name.length === 0 || !fitsName(name)) continue
        const prefix = path.slice(0, index)
        if (TEXT_ENCODER.encode(prefix).length > PREFIX_BYTES) continue
        return { name, prefix }
    }
    return null
}

/** One 512-byte ustar header for `entry`, or null when its path fits neither field. */
const ustarHeader = (entry: TarEntry): Uint8Array | null => {
    const isDirectory = entry.type === 'directory'
    // A directory's name ends in `/`, the way `tar -t` prints it.
    const nameSuffix = isDirectory ? '/' : ''
    const split = splitPath(entry.path, nameSuffix.length)
    if (!split) return null
    const header = new Uint8Array(BLOCK_BYTES)
    header.set(TEXT_ENCODER.encode(split.name + nameSuffix), 0)
    header.set(TEXT_ENCODER.encode(split.prefix), PREFIX_OFFSET)
    writeOctal(header, MODE_OFFSET, 7, isDirectory ? DIRECTORY_MODE : FILE_MODE)
    writeOctal(header, UID_OFFSET, 7, 0)
    writeOctal(header, GID_OFFSET, 7, 0)
    writeOctal(header, SIZE_OFFSET, 11, isDirectory ? 0 : entry.size)
    writeOctal(header, MTIME_OFFSET, 11, entry.mtime)
    // `0` is a regular file, `5` a directory.
    header[TYPEFLAG_OFFSET] = isDirectory ? 0x35 : 0x30
    header.set(TEXT_ENCODER.encode('ustar\0'), MAGIC_OFFSET)
    header.set(TEXT_ENCODER.encode('00'), VERSION_OFFSET)
    // The checksum sums every header byte with its own field read as spaces.
    header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8)
    let sum = 0
    for (const byte of header) sum += byte
    writeOctal(header, CHECKSUM_OFFSET, 6, sum)
    header[CHECKSUM_OFFSET + 7] = 0x20
    return header
}

/**
 * A pull-based ustar archive of `entries`, in the order they come: each pull writes one entry's
 * header, streams its bytes, pads to a block, and only then reads the next entry. `onEnd` gets
 * the archive's byte count once the two zero blocks are written. `logIds` names the run in the
 * two lines this writes.
 */
export const tarStream = (entries: AsyncIterable<TarEntry>, onEnd: (bytes: number) => void, logIds: LogIds): ReadableStream<Uint8Array> => {
    let writtenBytes = 0
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
        for await (const entry of entries) {
            const header = ustarHeader(entry)
            if (!header) {
                log('tar path skipped', { ...logIds, path: entry.path })
                continue
            }
            writtenBytes += header.length
            yield header

            let contentBytes = 0
            if (entry.read) {
                const content = (await entry.read()).getReader()
                try {
                    for (;;) {
                        const { done, value } = await content.read()
                        if (done) break
                        contentBytes += value.length
                        writtenBytes += value.length
                        yield value
                    }
                } finally {
                    content.releaseLock()
                }
            }
            if (contentBytes !== entry.size) {
                log('tar entry size differs from its header', {
                    ...logIds,
                    path: entry.path,
                    headerBytes: entry.size,
                    readBytes: contentBytes,
                })
            }
            const paddingBytes = (BLOCK_BYTES - contentBytes % BLOCK_BYTES) % BLOCK_BYTES
            if (paddingBytes > 0) {
                const padding = new Uint8Array(paddingBytes)
                writtenBytes += padding.length
                yield padding
            }
        }
        const end = new Uint8Array(BLOCK_BYTES * 2)
        writtenBytes += end.length
        yield end
        onEnd(writtenBytes)
    }

    const iterator = chunks()
    return new ReadableStream({
        async pull(controller) {
            const { done, value } = await iterator.next()
            if (done) controller.close()
            else controller.enqueue(value)
        },
        async cancel() {
            await iterator.return(undefined)
        },
    })
}

