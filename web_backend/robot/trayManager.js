// web_backend/robot/trayManager.js

class TrayManager {
    constructor() {
        this.currentSlot = 1;
        this.maxSlot = 2;
    }

    getCurrentSlot() {
        return this.currentSlot;
    }

    moveNext() {
        this.currentSlot += 1;

        if (this.currentSlot > this.maxSlot) {
            this.currentSlot = 1;
        }

        return this.currentSlot;
    }

    reset() {
        this.currentSlot = 1;
    }
}

module.exports = TrayManager;
