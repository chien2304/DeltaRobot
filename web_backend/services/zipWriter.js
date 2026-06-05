// web_backend/services/zipWriter.js

const fs = require("fs");

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }

    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;

    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosTimeDate(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2);
    const dosDate =
        ((year - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();

    return { dosTime, dosDate };
}

function u16(value) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(value);
    return b;
}

function u32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0);
    return b;
}

class ZipWriter {
    constructor() {
        this.parts = [];
        this.entries = [];
        this.offset = 0;
    }

    addText(name, text) {
        this.addBuffer(name, Buffer.from(text, "utf8"));
    }

    addFile(name, filePath) {
        this.addBuffer(name, fs.readFileSync(filePath));
    }

    addBuffer(name, data) {
        const normalizedName = String(name).replace(/\\/g, "/").replace(/^\/+/, "");
        const nameBuffer = Buffer.from(normalizedName, "utf8");
        const { dosTime, dosDate } = dosTimeDate();
        const checksum = crc32(data);

        const localHeader = Buffer.concat([
            u32(0x04034b50),
            u16(20),
            u16(0),
            u16(0),
            u16(dosTime),
            u16(dosDate),
            u32(checksum),
            u32(data.length),
            u32(data.length),
            u16(nameBuffer.length),
            u16(0),
            nameBuffer,
        ]);

        this.parts.push(localHeader, data);
        this.entries.push({
            nameBuffer,
            dosTime,
            dosDate,
            checksum,
            size: data.length,
            offset: this.offset,
        });
        this.offset += localHeader.length + data.length;
    }

    toBuffer() {
        const centralDirectoryOffset = this.offset;
        const centralParts = [];
        let centralDirectorySize = 0;

        for (const entry of this.entries) {
            const centralHeader = Buffer.concat([
                u32(0x02014b50),
                u16(20),
                u16(20),
                u16(0),
                u16(0),
                u16(entry.dosTime),
                u16(entry.dosDate),
                u32(entry.checksum),
                u32(entry.size),
                u32(entry.size),
                u16(entry.nameBuffer.length),
                u16(0),
                u16(0),
                u16(0),
                u16(0),
                u32(0),
                u32(entry.offset),
                entry.nameBuffer,
            ]);

            centralParts.push(centralHeader);
            centralDirectorySize += centralHeader.length;
        }

        const endRecord = Buffer.concat([
            u32(0x06054b50),
            u16(0),
            u16(0),
            u16(this.entries.length),
            u16(this.entries.length),
            u32(centralDirectorySize),
            u32(centralDirectoryOffset),
            u16(0),
        ]);

        return Buffer.concat([...this.parts, ...centralParts, endRecord]);
    }
}

module.exports = ZipWriter;
