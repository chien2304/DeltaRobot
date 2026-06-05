// web_backend/public/app.js

let socket = null;
let currentUser = null;
let latestRobotState = null;
let latestVisionState = null;
let roiUpdateTimer = null;
let isLoadingRoi = false;
let statusInterval = null;
let picksInterval = null;
let latestPicks = [];
let latestAnalyticsPicks = [];
let currentOperatorLock = null;

const SETTING_KEYS = [
    "L",
    "l",
    "R",
    "r",
    "CONVEYOR_SPEED",
    "UART_DELAY",
    "Z_CONVEYOR",
    "CENTER_X",
    "CENTER_Y",
    "STABLE_FRAMES",
    "Z_SAFE_PICK",
    "Z_SAFE_DROP",
    "HE_SO_GAP",
    "HE_SO_THA",
    "BLEND_ALPHA",
    "TRAY_SERVO_OFFSET"
];

async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "same-origin",
        ...options
    });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error || "API_ERROR");
    }

    return data;
}

async function refreshComPorts() {
    const select = document.getElementById("com-port");
    select.innerHTML = `<option value="">Đang tải COM...</option>`;

    try {
        const data = await api("/api/serial/ports");
        select.innerHTML = "";

        if (!data.ports || data.ports.length === 0) {
            select.innerHTML = `<option value="">Không tìm thấy COM</option>`;
            return;
        }

        for (const port of data.ports) {
            const option = document.createElement("option");
            option.value = port.path;
            option.textContent = port.path;
            select.appendChild(option);
        }
    } catch (err) {
        select.innerHTML = `<option value="">Lỗi tải COM</option>`;
        alert("Không đọc được danh sách COM: " + err.message);
    }
}

async function login() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    try {
        const data = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        currentUser = data.user;
        currentOperatorLock = data.operator_lock || null;
        showDashboard();
    } catch (err) {
        document.getElementById("login-error").textContent = err.message;
    }
}

async function logout() {
    await api("/api/logout", { method: "POST" });
    location.reload();
}

async function checkMe() {
    const data = await api("/api/me");
    if (data.user) {
        currentUser = data.user;
        currentOperatorLock = data.operator_lock || null;
        showDashboard();
    }
}

function showDashboard() {
    document.getElementById("login-page").classList.add("hidden");
    document.getElementById("dashboard").classList.remove("hidden");
    document.getElementById("user-info").textContent =
        `${currentUser.username} (${currentUser.role})`;

    applyRole();
    applyOperatorLock();
    connectSocket();
    refreshComPorts();
    loadRoi();
    refreshStatus();
    refreshPicks();

    if (!statusInterval) {
        statusInterval = setInterval(refreshStatus, 2000);
    }

    if (!picksInterval) {
        picksInterval = setInterval(refreshPicks, 3000);
    }
}

function applyRole() {
    const adminOnly = document.querySelectorAll(".admin-only");

    if (currentUser.role !== "admin") {
        adminOnly.forEach(el => {
            el.disabled = true;
            el.title = "Guest chỉ có quyền xem";
        });
    }
}

function isCurrentOperator() {
    return Boolean(
        currentUser &&
        currentUser.role === "admin" &&
        currentOperatorLock &&
        currentOperatorLock.is_operator
    );
}

function applyOperatorLock() {
    const info = document.getElementById("operator-lock-info");
    const btn = document.getElementById("operator-lock-btn");
    const operatorControls = document.querySelectorAll(".operator-control");
    const isAdmin = currentUser && currentUser.role === "admin";
    const isOperator = isCurrentOperator();
    const holder = currentOperatorLock && currentOperatorLock.holder
        ? currentOperatorLock.holder.username
        : null;

    if (info) {
        if (!isAdmin) {
            info.textContent = "";
        } else if (isOperator) {
            info.textContent = "Control: you";
        } else if (holder) {
            info.textContent = `Control: ${holder}`;
        } else {
            info.textContent = "Control: free";
        }
    }

    if (btn) {
        btn.classList.remove("locked-by-me", "locked-by-other");
        btn.disabled = !isAdmin || Boolean(holder && !isOperator);
        btn.textContent = isOperator ? "Release Control" : "Take Control";

        if (isOperator) btn.classList.add("locked-by-me");
        if (holder && !isOperator) btn.classList.add("locked-by-other");
    }

    operatorControls.forEach(el => {
        if (!isAdmin) return;

        el.disabled = !isOperator;
        el.title = isOperator
            ? ""
            : (holder ? `Control is held by ${holder}` : "Take Control before operating");
    });
}

async function toggleOperatorLock() {
    if (!currentUser || currentUser.role !== "admin") return;

    try {
        const endpoint = isCurrentOperator()
            ? "/api/operator-lock/release"
            : "/api/operator-lock/acquire";
        const data = await api(endpoint, { method: "POST" });
        currentOperatorLock = data.operator_lock || null;
        applyOperatorLock();
        await refreshStatus();
    } catch (err) {
        alert(err.message);
        await refreshStatus();
    }
}

function connectSocket() {
    if (socket) return;

    socket = io();

    socket.on("state", (state) => {
        latestRobotState = state;
        renderState();
        applyOperatorLock();
    });

    socket.on("operator_lock", () => {
        refreshStatus();
    });

    socket.on("uart_line", (line) => {
        appendPre("uart-log", line);
    });

    socket.on("event_log", (event) => {
        appendPre("event-log", `[${event.level}] ${event.message}`);
    });

    socket.on("new_pick", (pick) => {
        appendPre(
            "event-log",
            `PICK object=${pick.object_id}, slot=${pick.slot_id}, angle=${pick.object_angle.toFixed(1)}`
        );
    });
}

async function refreshStatus() {
    try {
        const data = await api("/api/status");
        latestRobotState = data.robot;
        latestVisionState = data.vision;
        currentOperatorLock = data.operator_lock || currentOperatorLock;
        renderState();
        applyOperatorLock();
    } catch (err) {
        console.error(err);
    }
}

function statusBadge(text, type) {
    return `<span class="status-badge ${type}">${text}</span>`;
}

function renderState() {
    const state = latestRobotState;
    const vision = latestVisionState;

    if (!state) return;

    const box = document.getElementById("state-box");
    const emergencyBanner = document.getElementById("emergency-banner");

    if (state.emergency) {
        document.body.classList.add("emergency-active");
        if (emergencyBanner) emergencyBanner.classList.remove("hidden");
    } else {
        document.body.classList.remove("emergency-active");
        if (emergencyBanner) emergencyBanner.classList.add("hidden");
    }

    const cameraOk = vision && vision.video_ready;

    box.innerHTML = `
        <div class="state-item">
            <span>UART</span>
            ${statusBadge(state.uartConnected ? "Connected" : "Disconnected", state.uartConnected ? "ok" : "bad")}
        </div>

        <div class="state-item">
            <span>Camera</span>
            ${statusBadge(cameraOk ? "Online" : "Offline", cameraOk ? "ok" : "bad")}
        </div>

        <div class="state-item">
            <span>System</span>
            ${statusBadge(state.running ? "Running" : "Stopped", state.running ? "ok" : "idle")}
        </div>

        <div class="state-item">
            <span>Homing</span>
            ${statusBadge(state.homed ? "Completed" : "Required", state.homed ? "ok" : "warn")}
        </div>

        <div class="state-item">
            <span>Robot</span>
            ${statusBadge(state.robotReady ? "Ready" : "Busy", state.robotReady ? "ok" : "warn")}
        </div>

        <div class="state-item">
            <span>Emergency</span>
            ${statusBadge(state.emergency ? "Active" : "Normal", state.emergency ? "bad" : "ok")}
        </div>

        <div class="state-item">
            <span>Current Slot</span>
            <b>${state.currentSlot}</b>
        </div>

        <div class="state-item">
            <span>Queue</span>
            <b>${vision ? vision.queue_len : "--"}</b>
        </div>
    `;

    updateConnectButton();
}

function appendPre(id, text) {
    const el = document.getElementById(id);
    if (!el) return;

    const now = new Date().toLocaleTimeString();
    el.textContent += `[${now}] ${text}\n`;
    el.scrollTop = el.scrollHeight;

    const lines = el.textContent.split("\n");
    if (lines.length > 200) {
        el.textContent = lines.slice(lines.length - 200).join("\n");
    }
}

function updateConnectButton() {
    const btn = document.getElementById("connect-btn");
    const select = document.getElementById("com-port");

    if (!btn || !latestRobotState) return;

    if (latestRobotState.uartConnected) {
        btn.textContent = "Disconnect";
        btn.classList.add("danger");
        if (select) select.disabled = true;
    } else {
        btn.textContent = "Connect";
        btn.classList.remove("danger");
        if (select) select.disabled = false;
    }
}

async function toggleUartConnection() {
    if (latestRobotState && latestRobotState.uartConnected) {
        await disconnectUart();
    } else {
        await connectUart();
    }
}

async function connectUart() {
    const port = document.getElementById("com-port").value;

    if (!port) {
        alert("Vui lòng chọn cổng COM");
        return;
    }

    try {
        await api("/api/connect", {
            method: "POST",
            body: JSON.stringify({ port })
        });
        await refreshStatus();
    } catch (err) {
        alert(err.message);
    }
}

async function disconnectUart() {
    if (!confirm("Ngắt kết nối UART?")) return;

    try {
        await api("/api/disconnect", { method: "POST" });
        await refreshStatus();
    } catch (err) {
        alert(err.message);
    }
}

function showTab(name) {
    document.querySelectorAll(".tab-page").forEach(page => {
        page.classList.remove("active");
    });

    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.remove("active");
    });

    const page = document.getElementById(`tab-${name}`);
    if (page) page.classList.add("active");

    const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
    if (btn) btn.classList.add("active");

    if (name === "history") refreshPicks();
    if (name === "analytics") {
        refreshPicks();
        refreshAnalytics();
    }
    if (name === "settings") loadSettings();
    if (name === "operation") loadRoi();
}

async function home() {
    try {
        await api("/api/home", { method: "POST" });
    } catch (err) {
        alert(err.message);
    }
}

async function start() {
    try {
        await api("/api/start", { method: "POST" });
    } catch (err) {
        alert(err.message);
    }
}

async function stop() {
    try {
        await api("/api/stop", { method: "POST" });
    } catch (err) {
        alert(err.message);
    }
}

async function resetEmergency() {
    if (!confirm("Bạn chắc chắn muốn reset emergency?")) return;

    try {
        await api("/api/reset", { method: "POST" });
    } catch (err) {
        alert(err.message);
    }
}

async function loadRoi() {
    try {
        isLoadingRoi = true;
        const data = await api("/api/roi");
        if (!data.ok) return;

        document.getElementById("roi-x1").value = data.roi.x1;
        document.getElementById("roi-y1").value = data.roi.y1;
        document.getElementById("roi-x2").value = data.roi.x2;
        document.getElementById("roi-y2").value = data.roi.y2;

        const status = document.getElementById("roi-status");
        if (status) {
            status.textContent = `ROI loaded: (${data.roi.x1}, ${data.roi.y1}) -> (${data.roi.x2}, ${data.roi.y2})`;
            status.className = "small-status";
        }
    } catch (err) {
        console.error(err);
    } finally {
        isLoadingRoi = false;
    }
}

function scheduleRoiUpdate() {
    if (isLoadingRoi) return;

    clearTimeout(roiUpdateTimer);
    roiUpdateTimer = setTimeout(updateRoiNow, 250);
}

async function updateRoiNow() {
    const status = document.getElementById("roi-status");
    const roi = {
        x1: Number(document.getElementById("roi-x1").value),
        y1: Number(document.getElementById("roi-y1").value),
        x2: Number(document.getElementById("roi-x2").value),
        y2: Number(document.getElementById("roi-y2").value)
    };

    if (roi.x2 <= roi.x1 || roi.y2 <= roi.y1) {
        if (status) {
            status.textContent = "ROI không hợp lệ: X2/Y2 phải lớn hơn X1/Y1.";
            status.className = "small-status bad";
        }
        return;
    }

    try {
        await api("/api/roi", {
            method: "POST",
            body: JSON.stringify(roi)
        });

        if (status) {
            status.textContent = `ROI updated: (${roi.x1}, ${roi.y1}) -> (${roi.x2}, ${roi.y2})`;
            status.className = "small-status ok";
        }
    } catch (err) {
        if (status) {
            status.textContent = "Lỗi cập nhật ROI: " + err.message;
            status.className = "small-status bad";
        }
    }
}

async function loadSettings() {
    try {
        const data = await api("/api/settings");
        const s = data.settings || {};

        for (const key of SETTING_KEYS) {
            const el = document.getElementById(`set-${key}`);
            if (el && s[key] !== undefined) {
                el.value = s[key];
            }
        }

        if (Array.isArray(s.TRAY_CENTER)) {
            document.getElementById("set-TRAY_CENTER_X").value = s.TRAY_CENTER[0];
            document.getElementById("set-TRAY_CENTER_Y").value = s.TRAY_CENTER[1];
            document.getElementById("set-TRAY_CENTER_Z").value = s.TRAY_CENTER[2];
        }
    } catch (err) {
        alert("Không tải được Settings: " + err.message);
    }
}

async function saveSettings() {
    const payload = {};

    for (const key of SETTING_KEYS) {
        const el = document.getElementById(`set-${key}`);
        if (!el) continue;

        payload[key] = key === "STABLE_FRAMES"
            ? parseInt(el.value, 10)
            : Number(el.value);
    }

    payload.TRAY_CENTER = [
        Number(document.getElementById("set-TRAY_CENTER_X").value),
        Number(document.getElementById("set-TRAY_CENTER_Y").value),
        Number(document.getElementById("set-TRAY_CENTER_Z").value)
    ];

    try {
        const data = await api("/api/settings", {
            method: "POST",
            body: JSON.stringify(payload)
        });

        alert(data.applied_runtime
            ? "Đã lưu và áp dụng Settings mới."
            : "Đã lưu Settings.");

        await loadSettings();
        await refreshStatus();
    } catch (err) {
        alert("Lưu Settings lỗi: " + err.message);
    }
}

async function testVacuum(on) {
    try {
        await api("/api/maintenance/vacuum", {
            method: "POST",
            body: JSON.stringify({ on })
        });
    } catch (err) {
        alert(err.message);
    }
}

async function testServo(angle) {
    try {
        await api("/api/maintenance/servo", {
            method: "POST",
            body: JSON.stringify({ angle })
        });
    } catch (err) {
        alert(err.message);
    }
}

async function jogAxis(axis, direction) {
    try {
        await api("/api/maintenance/jog-axis", {
            method: "POST",
            body: JSON.stringify({ axis, direction })
        });
    } catch (err) {
        alert(err.message);
    }
}

async function sendRawUart() {
    const command = document.getElementById("raw-uart-command").value.trim();

    if (!command) {
        alert("Nhập lệnh UART trước");
        return;
    }

    try {
        await api("/api/maintenance/raw-uart", {
            method: "POST",
            body: JSON.stringify({ command })
        });
        document.getElementById("raw-uart-command").value = "";
    } catch (err) {
        alert(err.message);
    }
}

async function refreshPicks() {
    try {
        const data = await api("/api/picks?limit=20");
        latestPicks = data.picks || [];
        renderPickSummary(data.summary);
        renderPickHistory(latestPicks);
        renderPickTimeChart(latestPicks);

        if (document.getElementById("tab-analytics")?.classList.contains("active")) {
            await refreshAnalytics();
        }
    } catch (err) {
        console.error(err);
    }
}

async function refreshAnalytics() {
    try {
        const data = await api("/api/analytics/picks");
        latestAnalyticsPicks = data.picks || [];
        renderPickHeatmap(latestAnalyticsPicks);
    } catch (err) {
        console.error(err);
    }
}

function renderPickSummary(summary) {
    const el = document.getElementById("pick-summary");
    if (!el) return;

    const rate = summary.total > 0
        ? (summary.successRate * 100).toFixed(1)
        : "0.0";

    el.innerHTML = `
        <div class="pick-summary-item">Tổng: <b>${summary.total}</b></div>
        <div class="pick-summary-item">OK: <b>${summary.success}</b></div>
        <div class="pick-summary-item">Tỉ lệ: <b>${rate}%</b></div>
        <div class="pick-summary-item">TB: <b>${summary.avgTime.toFixed(2)}s</b></div>
    `;
}

function renderPickHistory(picks) {
    const box = document.getElementById("pick-history");
    if (!box) return;

    if (!picks || picks.length === 0) {
        box.innerHTML = `<div style="color:#94a3b8;font-size:13px">Chưa có dữ liệu gắp.</div>`;
        return;
    }

    box.innerHTML = picks.map(p => {
        const statusClass =
            p.status === "success" ? "pick-ok" :
            p.status === "running" ? "pick-running" :
            "pick-error";

        const imageUrl = p.image_url || "";

        const started = p.started_at
            ? new Date(p.started_at).toLocaleTimeString()
            : "--";

        const duration = p.duration_s
            ? `${Number(p.duration_s).toFixed(2)}s`
            : "--";

        return `
            <div class="pick-row">
                <div>
                    ${imageUrl ? `<img src="${imageUrl}" alt="object">` : ""}
                </div>
                <div class="pick-info">
                    <b>Object #${p.object_id}</b>
                    <span class="${statusClass}">[${p.status}]</span><br>
                    Slot: ${p.slot_id} |
                    Góc vật (camera): ${Number(p.object_angle).toFixed(1)}° |
                    Góc servo khay: ${Number(p.tray_servo_angle).toFixed(1)}°<br>
                    Bắt đầu: ${started} |
                    Thời gian: ${duration}
                </div>
            </div>
        `;
    }).join("");
}

function renderAnalytics(picks) {
    renderPickTimeChart(picks);
    renderPickHeatmap(latestAnalyticsPicks);
}

function prepareCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const fallbackWidth = Number(canvas.getAttribute("width")) || 900;
    const fallbackHeight = Number(canvas.getAttribute("height")) || 320;
    const width = Math.max(320, Math.floor(rect.width || canvas.clientWidth || fallbackWidth));
    const height = Math.max(220, Math.floor(rect.height || canvas.clientHeight || fallbackHeight));

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    return { ctx, width, height };
}

function drawEmptyChart(canvas, message) {
    if (!canvas) return;

    const { ctx, width, height } = prepareCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050816";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "13px Segoe UI, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(message, width / 2, height / 2);
}

function renderPickTimeChart(picks) {
    const canvas = document.getElementById("pick-time-chart");
    const note = document.getElementById("time-chart-note");
    const rows = (picks || [])
        .filter(p => Number.isFinite(Number(p.duration_s)))
        .slice()
        .reverse();

    if (note) note.textContent = `${rows.length}/20 lần gắp`;

    if (!canvas || rows.length === 0) {
        drawEmptyChart(canvas, "Chưa có dữ liệu thời gian gắp hoàn tất");
        return;
    }

    const { ctx, width, height } = prepareCanvas(canvas);
    const pad = { left: 52, right: 20, top: 24, bottom: 44 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const values = rows.map(p => Number(p.duration_s));
    const maxValue = Math.max(1, ...values) * 1.15;
    const minValue = 0;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050816";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "#243044";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px Segoe UI, Arial, sans-serif";
    ctx.textAlign = "right";

    for (let i = 0; i <= 4; i++) {
        const y = pad.top + plotH - (plotH * i / 4);
        const value = maxValue * i / 4;

        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.fillText(`${value.toFixed(1)}s`, pad.left - 8, y + 4);
    }

    const pointX = index => rows.length === 1
        ? pad.left + plotW / 2
        : pad.left + (plotW * index / (rows.length - 1));
    const pointY = value => pad.top + plotH - ((value - minValue) / (maxValue - minValue)) * plotH;

    ctx.beginPath();
    rows.forEach((pick, index) => {
        const value = Number(pick.duration_s);
        const x = pointX(index);
        const y = pointY(value);

        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#2dd4bf";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    rows.forEach((pick, index) => {
        const value = Number(pick.duration_s);
        const x = pointX(index);
        const y = pointY(value);

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = pick.status === "success" ? "#facc15" : "#fb7185";
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#cbd5e1";
        ctx.textAlign = "center";
        ctx.font = "11px Segoe UI, Arial, sans-serif";
        ctx.fillText(String(pick.object_id || pick.id), x, height - 17);
    });

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px Segoe UI, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Object ID", pad.left + plotW / 2, height - 4);
}

function renderPickHeatmap(picks) {
    const canvas = document.getElementById("pick-heatmap");
    const note = document.getElementById("heatmap-note");
    const points = (picks || [])
        .map(p => ({
            x: Number(p.pick_x),
            y: Number(p.pick_y),
            status: p.status
        }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));

    if (note) note.textContent = `${points.length} vị trí gắp`;

    if (!canvas || points.length === 0) {
        drawEmptyChart(canvas, "Chưa có dữ liệu tọa độ X/Y");
        return;
    }

    const { ctx, width, height } = prepareCanvas(canvas);
    const pad = { left: 72, right: 104, top: 28, bottom: 58 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const marginX = Math.max(5, spanX * 0.08);
    const marginY = Math.max(5, spanY * 0.08);
    const axisMinX = minX - marginX;
    const axisMaxX = maxX + marginX;
    const axisMinY = minY - marginY;
    const axisMaxY = maxY + marginY;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#050816";
    ctx.fillRect(0, 0, width, height);

    drawSmoothHeatmap(ctx, {
        points,
        pad,
        plotW,
        plotH,
        axisMinX,
        axisMaxX,
        axisMinY,
        axisMaxY
    });

    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    drawAxisLabels(ctx, {
        pad,
        plotW,
        plotH,
        width,
        height,
        axisMinX,
        axisMaxX,
        axisMinY,
        axisMaxY
    });

    drawHeatLegend(ctx, width - 82, pad.top + 12, 16, plotH - 24);
}

function drawSmoothHeatmap(ctx, data) {
    const {
        points,
        pad,
        plotW,
        plotH,
        axisMinX,
        axisMaxX,
        axisMinY,
        axisMaxY
    } = data;
    const heatW = 260;
    const heatH = 170;
    const density = new Float32Array(heatW * heatH);
    const sigma = Math.max(7, Math.min(heatW, heatH) * 0.075);
    const radius = Math.ceil(sigma * 3);
    const twoSigmaSq = 2 * sigma * sigma;

    for (const point of points) {
        const px = ((point.x - axisMinX) / (axisMaxX - axisMinX)) * (heatW - 1);
        const py = ((axisMaxY - point.y) / (axisMaxY - axisMinY)) * (heatH - 1);
        const x0 = Math.max(0, Math.floor(px - radius));
        const x1 = Math.min(heatW - 1, Math.ceil(px + radius));
        const y0 = Math.max(0, Math.floor(py - radius));
        const y1 = Math.min(heatH - 1, Math.ceil(py + radius));

        for (let y = y0; y <= y1; y++) {
            const dy = y - py;

            for (let x = x0; x <= x1; x++) {
                const dx = x - px;
                density[y * heatW + x] += Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
            }
        }
    }

    const maxDensity = Math.max(1, ...density);
    const heatCanvas = document.createElement("canvas");
    heatCanvas.width = heatW;
    heatCanvas.height = heatH;

    const heatCtx = heatCanvas.getContext("2d");
    const image = heatCtx.createImageData(heatW, heatH);

    for (let i = 0; i < density.length; i++) {
        const value = Math.pow(density[i] / maxDensity, 0.62);
        const color = heatRgb(value);
        const offset = i * 4;

        image.data[offset] = color[0];
        image.data[offset + 1] = color[1];
        image.data[offset + 2] = color[2];
        image.data[offset + 3] = 232;
    }

    heatCtx.putImageData(image, 0, 0);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(heatCanvas, pad.left, pad.top, plotW, plotH);
    ctx.restore();

    return maxDensity;
}

function heatRgb(value) {
    const stops = [
        { at: 0.00, color: [65, 160, 200] },
        { at: 0.24, color: [82, 190, 120] },
        { at: 0.48, color: [250, 232, 48] },
        { at: 0.66, color: [255, 145, 28] },
        { at: 0.82, color: [238, 42, 36] },
        { at: 1.00, color: [95, 35, 24] },
    ];

    const clamped = Math.max(0, Math.min(1, value));
    let left = stops[0];
    let right = stops[stops.length - 1];

    for (let i = 1; i < stops.length; i++) {
        if (clamped <= stops[i].at) {
            left = stops[i - 1];
            right = stops[i];
            break;
        }
    }

    const t = (clamped - left.at) / Math.max(0.001, right.at - left.at);
    return left.color.map((channel, i) => Math.round(channel + (right.color[i] - channel) * t));
}

function heatColor(value) {
    const color = heatRgb(value);
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function drawAxisLabels(ctx, data) {
    const {
        pad,
        plotW,
        plotH,
        height,
        axisMinX,
        axisMaxX,
        axisMinY,
        axisMaxY
    } = data;

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px Segoe UI, Arial, sans-serif";
    ctx.fillStyle = "#cbd5e1";
    ctx.textAlign = "center";
    ctx.fillText("Pick X (mm)", pad.left + plotW / 2, height - 12);

    ctx.fillStyle = "#94a3b8";
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
        const x = pad.left + plotW * i / 4;
        const y = pad.top + plotH - plotH * i / 4;
        const xValue = axisMinX + (axisMaxX - axisMinX) * i / 4;
        const yValue = axisMinY + (axisMaxY - axisMinY) * i / 4;

        ctx.beginPath();
        ctx.moveTo(x, pad.top + plotH);
        ctx.lineTo(x, pad.top + plotH + 5);
        ctx.moveTo(pad.left - 5, y);
        ctx.lineTo(pad.left, y);
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.fillText(xValue.toFixed(1), x, pad.top + plotH + 18);

        ctx.textAlign = "right";
        ctx.fillText(yValue.toFixed(1), pad.left - 8, y + 4);
    }

    ctx.save();
    ctx.translate(15, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Pick Y (mm)", 0, 0);
    ctx.restore();
}

function drawHeatLegend(ctx, x, y, width, height) {
    const steps = Math.max(60, Math.floor(height));

    for (let i = 0; i < steps; i++) {
        const t = 1 - i / (steps - 1);
        ctx.fillStyle = heatColor(t);
        ctx.fillRect(x, y + i * height / steps, width, Math.ceil(height / steps));
    }

    ctx.strokeStyle = "#64748b";
    ctx.strokeRect(x, y, width, height);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px Segoe UI, Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Cao", x + width + 8, y + 4);
    ctx.fillText("Thấp", x + width + 8, y + height - 2);
}

function exportHistoryPackage() {
    window.location.href = "/api/export/picks.zip";
}

window.addEventListener("resize", () => {
    renderAnalytics(latestPicks);
});

checkMe();
