// web_backend/services/visionClient.js

const axios = require("axios");

class VisionClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async getStatus() {
        const res = await axios.get(`${this.baseUrl}/api/status`);
        return res.data;
    }

    async startVision() {
        const res = await axios.post(`${this.baseUrl}/api/start-vision`);
        return res.data;
    }

    async stopVision() {
        const res = await axios.post(`${this.baseUrl}/api/stop-vision`);
        return res.data;
    }

    async planNextPick(payload) {
        const res = await axios.post(`${this.baseUrl}/api/plan-next-pick`, payload);
        return res.data;
    }
        async getRoi() {
        const res = await axios.get(`${this.baseUrl}/api/roi`);
        return res.data;
    }

    async setRoi(roi) {
        const res = await axios.post(`${this.baseUrl}/api/roi`, roi);
        return res.data;
    }
        async getSettings() {
        const res = await axios.get(`${this.baseUrl}/api/settings`);
        return res.data;
    }

    async saveSettings(settings) {
        const res = await axios.post(`${this.baseUrl}/api/settings`, settings);
        return res.data;
    }
}

module.exports = VisionClient;