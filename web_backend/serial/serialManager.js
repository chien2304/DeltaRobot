// web_backend/serial/serialManager.js

const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

class SerialManager {
    constructor() {
        this.port = null;
        this.parser = null;
        this.lineCallback = null;
    }

    async connect(path, baudRate = 115200) {
        if (this.port && this.port.isOpen) {
            await this.close();
        }

        this.port = new SerialPort({
            path,
            baudRate,
            autoOpen: false
        });

        await new Promise((resolve, reject) => {
            this.port.open((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        this.parser = this.port.pipe(new ReadlineParser({
            delimiter: "\n"
        }));

        this.parser.on("data", (line) => {
            const clean = String(line).trim();

            if (this.lineCallback && clean.length > 0) {
                this.lineCallback(clean);
            }
        });
    }

    async close() {
        if (!this.port) return;

        await new Promise((resolve) => {
            this.port.close(() => resolve());
        });

        this.port = null;
        this.parser = null;
    }

    writeLine(line) {
        if (!this.port || !this.port.isOpen) {
            throw new Error("Serial port is not open");
        }

        this.port.write(line + "\n");
    }

    writeRaw(data) {
        if (!this.port || !this.port.isOpen) {
            throw new Error("Serial port is not open");
        }

        this.port.write(data);
    }

    onLine(callback) {
        this.lineCallback = callback;
    }
}

module.exports = SerialManager;