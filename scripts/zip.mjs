import { deflateRawSync } from "node:zlib"

/**
 * Minimal ZIP writer. The plugin ships with no runtime dependencies and the packaging step keeps
 * that property: Node's zlib supplies deflate, and the container format is a few headers.
 */

// The reversed CRC-32 polynomial. Getting a digit wrong here produces an archive that lenient
// readers accept and strict ones reject, which is why the round-trip test uses libarchive.
const CRC32_POLYNOMIAL = 0xed_b8_83_20

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? CRC32_POLYNOMIAL ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data) {
  let crc = 0xff_ff_ff_ff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}

// MS-DOS date and time, the only timestamp the base format carries.
function dosStamp(date) {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11)
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (((date.getFullYear() - 1980) & 0x7f) << 9)
  return { day, time }
}

/**
 * @param {{ data: Buffer, path: string }[]} entries paths use forward slashes
 * @param {Date} modified one timestamp for every entry, so the archive is reproducible
 * @returns {Buffer}
 */
export function createZip(entries, modified = new Date(0)) {
  const stamp = dosStamp(modified)
  const locals = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8")
    const compressed = deflateRawSync(entry.data)
    // A tiny file can deflate larger than it started; store it uncompressed when that happens.
    const stored = compressed.length >= entry.data.length
    const body = stored ? entry.data : compressed
    const method = stored ? 0 : 8
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04_03_4b_50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02_01_4b_50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.day, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    // Unix mode 0100644 in the high half. Shifting with << would overflow into a negative int32.
    header.writeUInt32LE((0o100_644 * 0x1_00_00) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06_05_4b_50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}
