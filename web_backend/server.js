// web_backend/server.js

const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");

const SerialManager = require("./serial/serialManager");
const TrayManager = require("./robot/trayManager");
const VisionClient = require("./services/visionClient");
const LogService = require("./services/logService");
const ImageService = require("./services/imageService");
const { buildHistoryZip, rowsToCsv } = require("./services/historyExportService");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const PICK_TIMEOUT_MS = 20000;
const axios = require("axios");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || "delta_robot_secret_key_change_later",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax"
    }
}));

app.use(express.static(path.join(__dirname, "public")));

const users = [
    {
        username: "admin",
        passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || "admin123", 10),
        role: "admin"
    },
    {
        username: "guest",
        passwordHash: bcrypt.hashSync(process.env.GUEST_PASSWORD || "guest123", 10),
        role: "guest"
    }
];

const serial = new SerialManager();
const tray = new TrayManager();
const vision = new VisionClient(process.env.VISION_BASE_URL || "http://127.0.0.1:8000");
const logs = new LogService();
const images = new ImageService();
const OPERATOR_LOCK_TIMEOUT_MS = Number(process.env.OPERATOR_LOCK_TIMEOUT_MS || 60000);

let operatorLock = null;

let robotState = {
    uartConnected: false,
    running: false,
    homed: false,
    emergency: false,
    robotReady: true,
    currentSlot: 1,
    commandId: 1,
    robotPos: [0.0, 0.0, -180.0],
    lastPick: null,
    lastError: null
};

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            ok: false,
            error: "LOGIN_REQUIRED"
        });
    }

    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            ok: false,
            error: "LOGIN_REQUIRED"
        });
    }

    if (req.session.user.role !== "admin") {
        return res.status(403).json({
            ok: false,
            error: "ADMIN_ONLY"
        });
    }

    next();
}

function pruneOperatorLock() {
    if (
        operatorLock &&
        Date.now() - operatorLock.lastSeenAt > OPERATOR_LOCK_TIMEOUT_MS
    ) {
        const releasedUser = operatorLock.username;
        operatorLock = null;
        addEvent("WARN", `Operator lock expired: ${releasedUser}`);
        broadcastOperatorLock();
    }
}

function lockInfoFor(req) {
    pruneOperatorLock();

    if (!operatorLock) {
        return {
            locked: false,
            is_operator: false,
            holder: null,
            expires_in_ms: 0
        };
    }

    const isOperator = Boolean(req.session && req.sessionID === operatorLock.sessionId);

    return {
        locked: true,
        is_operator: isOperator,
        holder: {
            username: operatorLock.username,
            acquired_at: operatorLock.acquiredAt
        },
        expires_in_ms: Math.max(0, OPERATOR_LOCK_TIMEOUT_MS - (Date.now() - operatorLock.lastSeenAt))
    };
}

function touchOperatorLock(req) {
    if (operatorLock && req.sessionID === operatorLock.sessionId) {
        operatorLock.lastSeenAt = Date.now();
    }
}

function releaseOperatorLockForSession(sessionId) {
    if (operatorLock && operatorLock.sessionId === sessionId) {
        const releasedUser = operatorLock.username;
        operatorLock = null;
        addEvent("INFO", `Operator released: ${releasedUser}`);
        broadcastOperatorLock();
        return true;
    }

    return false;
}

function requireOperator(req, res, next) {
    requireAdmin(req, res, () => {
        pruneOperatorLock();

        if (!operatorLock) {
            return res.status(423).json({
                ok: false,
                error: "OPERATOR_LOCK_REQUIRED",
                operator_lock: lockInfoFor(req)
            });
        }

        if (operatorLock.sessionId !== req.sessionID) {
            return res.status(423).json({
                ok: false,
                error: "OPERATOR_LOCK_HELD",
                operator_lock: lockInfoFor(req)
            });
        }

        touchOperatorLock(req);
        next();
    });
}

function broadcastState() {
    io.emit("state", robotState);
}

function broadcastOperatorLock() {
    io.emit("operator_lock", operatorLock ? {
        locked: true,
        holder: {
            username: operatorLock.username,
            acquired_at: operatorLock.acquiredAt
        }
    } : {
        locked: false,
        holder: null
    });
}

function addEvent(level, message) {
    logs.addEvent("WEB", level, message);
    io.emit("event_log", {
        time: new Date().toISOString(),
        level,
        message
    });
}

function finishCurrentPick(status, error = null) {
    if (!robotState.lastPick) return false;

    const pick = robotState.lastPick;

    if (status === "success") {
        robotState.robotPos = pick.drop_pos;
        logs.finishPick(pick.pick_db_id, "success", null);
        addEvent("INFO", `Pick done: object ${pick.object_id}, slot ${pick.slot_id}`);

        tray.moveNext();
        robotState.currentSlot = tray.getCurrentSlot();
    } else {
        logs.finishPick(pick.pick_db_id, "failed", error);
        addEvent("ERROR", `Pick failed: object ${pick.object_id}, ${error}`);
    }

    robotState.lastPick = null;
    return true;
}

function failCurrentPick(error) {
    finishCurrentPick("failed", error);
}

function checkPickTimeout() {
    if (!robotState.lastPick) return false;

    const elapsed = Date.now() - robotState.lastPick.started_at_ms;
    if (elapsed <= PICK_TIMEOUT_MS) return false;

    failCurrentPick(`UART timeout after ${Math.round(elapsed / 1000)}s`);
    robotState.running = false;
    robotState.robotReady = false;
    robotState.lastError = "UART_PICK_TIMEOUT";

    vision.stopVision().catch(() => {});
    broadcastState();
    return true;
}

serial.onLine((line) => {
    if (line !== "Q") {
        io.emit("uart_line", line);
    }
    if (line === "A") {
        robotState.uartConnected = true;
    }

    if (line.startsWith("OK|ID") && line.includes("|DONE")) {
        const commandId = Number(line.split("|")[1].replace("ID", ""));

        if (
            robotState.lastPick &&
            robotState.lastPick.command_id === commandId
        ) {
            robotState.robotReady = true;
            finishCurrentPick("success");
        }
    }

    if (line.startsWith("ERR|ID")) {
        const parts = line.split("|");
        const commandId = Number((parts[1] || "").replace("ID", ""));
        const reason = parts.slice(2).join("|") || "UART command error";

        if (
            robotState.lastPick &&
            robotState.lastPick.command_id === commandId
        ) {
            robotState.robotReady = true;
            failCurrentPick(reason);
        }
    }

    if (line === "R") {
        robotState.robotReady = true;

        finishCurrentPick("success");
    }

    if (line.includes("STATUS|HOMING_DONE")) {
        robotState.homed = true;
        robotState.robotReady = true;
        robotState.robotPos = [0.0, 0.0, -180.0];
        addEvent("INFO", "Homing done");
    }

    if (line.includes("STATUS|EMERGENCY_STOP")) {
        robotState.emergency = true;
        robotState.running = false;
        robotState.robotReady = false;
        failCurrentPick("Emergency stop");

        vision.stopVision().catch(() => {});

        addEvent("ERROR", "Emergency stop - vision stopped, reset required");
    }

    if (line.includes("STATUS|RESET_OK")) {
        robotState.emergency = false;
        robotState.running = false;
        robotState.homed = false;
        robotState.robotReady = true;
        failCurrentPick("Emergency reset");

        vision.stopVision().catch(() => {});

        addEvent("INFO", "Emergency reset OK. Please Home before Start.");
    }

    broadcastState();
});

// -------------------- AUTH --------------------

app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;

    const user = users.find(u => u.username === username);

    if (!user) {
        return res.status(401).json({
            ok: false,
            error: "INVALID_LOGIN"
        });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);

    if (!ok) {
        return res.status(401).json({
            ok: false,
            error: "INVALID_LOGIN"
        });
    }

    req.session.user = {
        username: user.username,
        role: user.role
    };

    res.json({
        ok: true,
        user: req.session.user
    });
});

app.post("/api/logout", requireLogin, (req, res) => {
    const sessionId = req.sessionID;

    req.session.destroy(() => {
        releaseOperatorLockForSession(sessionId);
        res.json({ ok: true });
    });
});

app.get("/api/me", (req, res) => {
    res.json({
        ok: true,
        user: req.session.user || null,
        operator_lock: lockInfoFor(req)
    });
});

app.get("/api/operator-lock", requireAdmin, (req, res) => {
    touchOperatorLock(req);

    res.json({
        ok: true,
        operator_lock: lockInfoFor(req)
    });
});

app.post("/api/operator-lock/acquire", requireAdmin, (req, res) => {
    pruneOperatorLock();

    if (operatorLock && operatorLock.sessionId !== req.sessionID) {
        return res.status(423).json({
            ok: false,
            error: "OPERATOR_LOCK_HELD",
            operator_lock: lockInfoFor(req)
        });
    }

    const now = Date.now();

    operatorLock = {
        sessionId: req.sessionID,
        username: req.session.user.username,
        acquiredAt: new Date(now).toISOString(),
        lastSeenAt: now
    };

    addEvent("INFO", `Operator acquired: ${operatorLock.username}`);
    broadcastOperatorLock();

    res.json({
        ok: true,
        operator_lock: lockInfoFor(req)
    });
});

app.post("/api/operator-lock/release", requireAdmin, (req, res) => {
    const released = releaseOperatorLockForSession(req.sessionID);

    res.json({
        ok: true,
        released,
        operator_lock: lockInfoFor(req)
    });
});
// -------------------MAINTENANCE ----------------
function requireUartReady(res) {
    if (!robotState.uartConnected) {
        res.status(400).json({
            ok: false,
            error: "UART_NOT_CONNECTED"
        });
        return false;
    }

    if (robotState.emergency) {
        res.status(400).json({
            ok: false,
            error: "EMERGENCY_ACTIVE"
        });
        return false;
    }

    return true;
}

app.post("/api/maintenance/vacuum", requireOperator, (req, res) => {
    if (!requireUartReady(res)) return;

    const on = Boolean(req.body.on);

    serial.writeLine(on ? "S|V1|D200" : "S|V0|D200");
    addEvent("INFO", `Maintenance: Vacuum ${on ? "ON" : "OFF"}`);

    res.json({ ok: true });
});

app.post("/api/maintenance/servo", requireOperator, (req, res) => {
    if (!requireUartReady(res)) return;

    const angle = Number(req.body.angle);

    if (![0, 90, 180].includes(angle)) {
        return res.status(400).json({
            ok: false,
            error: "INVALID_SERVO_ANGLE"
        });
    }

    serial.writeLine(`S|G${angle}|D300`);
    addEvent("INFO", `Maintenance: Servo ${angle} deg`);

    res.json({ ok: true });
});

app.post("/api/maintenance/jog-axis", requireOperator, (req, res) => {
    if (!requireUartReady(res)) return;

    const axis = Number(req.body.axis);
    const direction = String(req.body.direction || "");

    if (![1, 2, 3].includes(axis)) {
        return res.status(400).json({
            ok: false,
            error: "INVALID_AXIS"
        });
    }

    if (!["up", "down"].includes(direction)) {
        return res.status(400).json({
            ok: false,
            error: "INVALID_DIRECTION"
        });
    }

    const sign = direction === "up" ? "+" : "-";

    // Firmware sẽ sửa để hiểu J1+5, J1-5, J2+5...
    const cmd = `J${axis}${sign}5`;

    serial.writeLine(cmd);
    addEvent("INFO", `Maintenance: ${cmd}`);

    res.json({
        ok: true,
        command: cmd
    });
});

app.post("/api/maintenance/raw-uart", requireOperator, (req, res) => {
    if (!requireUartReady(res)) return;

    let command = String(req.body.command || "").trim();

    while (command.endsWith("|")) {
        command = command.slice(0, -1).trim();
    }

    if (!command) {
        return res.status(400).json({
            ok: false,
            error: "EMPTY_COMMAND"
        });
    }

    if (command.length > 255) {
        return res.status(400).json({
            ok: false,
            error: "COMMAND_TOO_LONG"
        });
    }

    serial.writeLine(command);
    addEvent("WARN", `Raw UART: ${command}`);

    res.json({
        ok: true,
        command
    });
});
// --------------------UPDATE ROI -----------------
app.get("/api/roi", requireAdmin, async (req, res) => {
    try {
        const data = await vision.getRoi();
        res.json(data);
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

app.post("/api/roi", requireOperator, async (req, res) => {
    try {
        const data = await vision.setRoi(req.body);
        addEvent("INFO", "ROI updated");
        res.json(data);
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});
// --------------------VIDEO-----------------------
app.get("/video_feed", requireLogin, async (req, res) => {
    try {
        const response = await axios({
            method: "get",
            url: "http://127.0.0.1:8000/video_feed",
            responseType: "stream"
        });

        res.setHeader(
            "Content-Type",
            response.headers["content-type"] || "multipart/x-mixed-replace; boundary=frame"
        );

        response.data.pipe(res);
    } catch (err) {
        res.status(503).send("Vision Service is not available");
    }
});

// -------------------- STATUS --------------------

app.get("/api/status", requireLogin, async (req, res) => {
    touchOperatorLock(req);

    let visionStatus = null;

    try {
        visionStatus = await vision.getStatus();
    } catch (err) {
        visionStatus = {
            ok: false,
            error: err.message
        };
    }

    res.json({
        ok: true,
        user: req.session.user,
        operator_lock: lockInfoFor(req),
        robot: robotState,
        vision: visionStatus,
        tray: {
            currentSlot: tray.getCurrentSlot()
        }
    });
});
app.get("/api/picks", requireLogin, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "20"), 100);
    const picks = logs.getRecentPicks(limit).map(row => ({
        ...row,
        image_url: images.publicUrlForPick(row)
    }));

    res.json({
        ok: true,
        picks,
        summary: logs.getSummary()
    });
});

app.get("/api/picks/:id/image", requireLogin, (req, res) => {
    const row = logs.getPickById(Number(req.params.id));
    const resolved = images.resolve(row);

    if (!resolved) {
        return res.status(404).json({
            ok: false,
            error: "IMAGE_NOT_FOUND"
        });
    }

    res.sendFile(resolved.absolutePath);
});

app.get("/api/analytics/picks", requireLogin, (req, res) => {
    const picks = logs.getPicksForAnalytics();

    res.json({
        ok: true,
        picks
    });
});

app.get("/api/export/picks.csv", requireLogin, (req, res) => {
    const rows = logs.getAllPicksForCsv().map(row => {
        const resolved = images.resolve(row);
        return {
            ...row,
            image_file: resolved ? resolved.archivePath : ""
        };
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=delta_robot_picks.csv");
    res.send(rowsToCsv(rows));
});

app.get("/api/export/picks.zip", requireLogin, (req, res) => {
    const rows = logs.getAllPicksForCsv();
    const zip = buildHistoryZip(rows, images);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=delta_robot_history_${stamp}.zip`);
    res.send(zip);
});
app.get("/api/serial/ports", requireLogin, async (req, res) => {
    try {
        const ports = await SerialPort.list();

        res.json({
            ok: true,
            ports: ports.map(p => ({
                path: p.path,
                manufacturer: p.manufacturer || "",
                friendlyName: p.friendlyName || "",
                serialNumber: p.serialNumber || "",
                vendorId: p.vendorId || "",
                productId: p.productId || ""
            }))
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});
// -------------------- ADMIN CONTROL --------------------

app.post("/api/connect", requireOperator, async (req, res) => {
    const { port } = req.body;

    try {
        await serial.connect(port, 115200);
        robotState.uartConnected = true;
        robotState.lastError = null;
        addEvent("INFO", `UART connected: ${port}`);
        broadcastState();

        res.json({ ok: true });
    } catch (err) {
        robotState.uartConnected = false;
        robotState.lastError = err.message;
        addEvent("ERROR", `UART connect error: ${err.message}`);
        broadcastState();

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});
app.post("/api/disconnect", requireOperator, async (req, res) => {
    try {
        await serial.close();

        robotState.uartConnected = false;
        robotState.running = false;
        robotState.homed = false;
        robotState.robotReady = true;
        failCurrentPick("UART disconnected");
        robotState.lastError = null;

        try {
            await vision.stopVision();
        } catch (_) {}

        addEvent("INFO", "UART disconnected");
        broadcastState();

        res.json({ ok: true });
    } catch (err) {
        robotState.lastError = err.message;
        addEvent("ERROR", `UART disconnect error: ${err.message}`);
        broadcastState();

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});
app.post("/api/home", requireOperator, async (req, res) => {
    if (!robotState.uartConnected) {
        return res.status(400).json({
            ok: false,
            error: "UART_NOT_CONNECTED"
        });
    }

    robotState.homed = false;
    robotState.robotReady = false;

    serial.writeLine("H");
    addEvent("INFO", "Send HOME");

    broadcastState();

    res.json({ ok: true });
});

app.post("/api/start", requireOperator, async (req, res) => {
    if (!robotState.uartConnected) {
        return res.status(400).json({
            ok: false,
            error: "UART_NOT_CONNECTED"
        });
    }

    if (!robotState.homed) {
        return res.status(400).json({
            ok: false,
            error: "NOT_HOMED"
        });
    }

    if (robotState.emergency) {
        return res.status(400).json({
            ok: false,
            error: "EMERGENCY_ACTIVE"
        });
    }

    robotState.running = true;
    robotState.robotReady = true;
    robotState.lastError = null;

    await vision.startVision();

    addEvent("INFO", "System started");
    broadcastState();

    res.json({ ok: true });
});

app.post("/api/stop", requireOperator, async (req, res) => {
    robotState.running = false;
    failCurrentPick("System stopped");

    try {
        await vision.stopVision();
    } catch (_) {}

    addEvent("INFO", "System stopped");
    broadcastState();

    res.json({ ok: true });
});

app.post("/api/reset", requireOperator, async (req, res) => {
    if (!robotState.uartConnected) {
        return res.status(400).json({
            ok: false,
            error: "UART_NOT_CONNECTED"
        });
    }

    serial.writeLine("X");

    robotState.running = false;
    robotState.homed = false;
    failCurrentPick("Emergency reset requested");

    addEvent("INFO", "Send RESET");
    broadcastState();

    res.json({ ok: true });
});

app.get("/api/settings", requireAdmin, async (req, res) => {
    try {
        const data = await vision.getSettings();
        res.json(data);
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

app.post("/api/settings", requireOperator, async (req, res) => {
    try {
        const data = await vision.saveSettings(req.body);
        addEvent("INFO", "Settings saved and applied.");
        res.json(data);
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// -------------------- PICK LOOP --------------------

async function pickLoop() {
    setInterval(async () => {
        if (!robotState.running) return;
        if (!robotState.uartConnected) return;
        if (!robotState.homed) return;
        if (robotState.emergency) return;
        if (!robotState.robotReady) {
            checkPickTimeout();
            return;
        }

        try {
            robotState.robotReady = false;

            const slotId = tray.getCurrentSlot();
            const commandId = robotState.commandId;

            const plan = await vision.planNextPick({
                slot_id: slotId,
                robot_pos: robotState.robotPos,
                command_id: commandId
            });

            if (!plan.ok) {
                robotState.robotReady = true;

                if (plan.reason !== "NO_TARGET" && plan.reason !== "OBJECT_NOT_READY") {
                    addEvent("WARN", `Plan failed: ${plan.reason}`);
                }

                broadcastState();
                return;
            }

            robotState.commandId += 1;

            const pickDbId = logs.startPick({
                object_id: plan.object_id,
                slot_id: plan.slot_id,
                object_angle: plan.object_angle,
                tray_servo_angle: plan.tray_servo_angle,
                pick_pos: plan.pick_pos,
                drop_pos: plan.drop_pos,
                image_path: plan.image_path,
                command: plan.uart_command
            });

            robotState.lastPick = {
                pick_db_id: pickDbId,
                command_id: commandId,
                object_id: plan.object_id,
                slot_id: plan.slot_id,
                drop_pos: plan.drop_pos,
                started_at_ms: Date.now()
            };

            serial.writeRaw(plan.uart_command);

            addEvent("INFO", `Send pick command: object ${plan.object_id}, slot ${plan.slot_id}`);
            io.emit("new_pick", plan);

            broadcastState();

        } catch (err) {
            failCurrentPick(err.message);
            robotState.robotReady = true;
            robotState.lastError = err.message;

            addEvent("ERROR", `Pick loop error: ${err.message}`);
            broadcastState();
        }
    }, 300);
}

pickLoop();

// -------------------- SOCKET --------------------

io.on("connection", (socket) => {
    socket.emit("state", robotState);
});

// -------------------- START --------------------

server.listen(PORT, () => {
    console.log(`WEB_BACKEND_READY http://127.0.0.1:${PORT}`);
});
