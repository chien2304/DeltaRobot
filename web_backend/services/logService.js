// web_backend/services/logService.js

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

class LogService {
    constructor() {
        const dbPath = path.resolve(
            process.env.ROBOT_DB_PATH ||
            path.join(__dirname, "..", "data", "robot.db")
        );
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.init();
    }

    init() {
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS picks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                object_id INTEGER,
                slot_id INTEGER,
                object_angle REAL,
                tray_servo_angle REAL,
                pick_x REAL,
                pick_y REAL,
                pick_z REAL,
                drop_x REAL,
                drop_y REAL,
                drop_z REAL,
                image_path TEXT,
                command TEXT,
                status TEXT,
                error TEXT,
                started_at TEXT,
                finished_at TEXT,
                duration_s REAL
            )
        `).run();

        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT,
                source TEXT,
                level TEXT,
                message TEXT
            )
        `).run();

        this.ensureColumn("picks", "pick_x", "REAL");
        this.ensureColumn("picks", "pick_y", "REAL");
        this.ensureColumn("picks", "pick_z", "REAL");
    }

    ensureColumn(tableName, columnName, columnType) {
        const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
        const exists = columns.some(col => col.name === columnName);

        if (!exists) {
            this.db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`).run();
        }
    }

    addEvent(source, level, message) {
        this.db.prepare(`
            INSERT INTO events (time, source, level, message)
            VALUES (?, ?, ?, ?)
        `).run(
            new Date().toISOString(),
            source,
            level,
            message
        );
    }

    startPick(data) {
        const startedAt = new Date().toISOString();

        const stmt = this.db.prepare(`
            INSERT INTO picks (
                object_id,
                slot_id,
                object_angle,
                tray_servo_angle,
                pick_x,
                pick_y,
                pick_z,
                drop_x,
                drop_y,
                drop_z,
                image_path,
                command,
                status,
                error,
                started_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            data.object_id,
            data.slot_id,
            data.object_angle,
            data.tray_servo_angle,
            data.pick_pos[0],
            data.pick_pos[1],
            data.pick_pos[2],
            data.drop_pos[0],
            data.drop_pos[1],
            data.drop_pos[2],
            data.image_path,
            data.command,
            "running",
            null,
            startedAt
        );

        return result.lastInsertRowid;
    }

    finishPick(id, status, error) {
        const row = this.db.prepare(`
            SELECT started_at FROM picks WHERE id = ?
        `).get(id);

        const finishedAt = new Date();
        let duration = null;

        if (row && row.started_at) {
            duration = (finishedAt - new Date(row.started_at)) / 1000.0;
        }

        this.db.prepare(`
            UPDATE picks
            SET status = ?,
                error = ?,
                finished_at = ?,
                duration_s = ?
            WHERE id = ?
        `).run(
            status,
            error,
            finishedAt.toISOString(),
            duration,
            id
        );
    }
    getRecentPicks(limit = 20) {
        return this.db.prepare(`
            SELECT
                id,
                object_id,
                slot_id,
                object_angle,
                tray_servo_angle,
                pick_x,
                pick_y,
                pick_z,
                drop_x,
                drop_y,
                drop_z,
                image_path,
                status,
                error,
                started_at,
                finished_at,
                duration_s
            FROM picks
            ORDER BY id DESC
            LIMIT ?
        `).all(limit);
    }

    getPickById(id) {
        return this.db.prepare(`
            SELECT
                id,
                object_id,
                slot_id,
                object_angle,
                tray_servo_angle,
                pick_x,
                pick_y,
                pick_z,
                drop_x,
                drop_y,
                drop_z,
                image_path,
                status,
                error,
                started_at,
                finished_at,
                duration_s
            FROM picks
            WHERE id = ?
        `).get(id);
    }

    getPicksForAnalytics() {
        return this.db.prepare(`
            SELECT
                id,
                object_id,
                slot_id,
                pick_x,
                pick_y,
                pick_z,
                status,
                started_at,
                finished_at,
                duration_s
            FROM picks
            WHERE pick_x IS NOT NULL
              AND pick_y IS NOT NULL
            ORDER BY id ASC
        `).all();
    }

    getSummary() {
        const total = this.db.prepare(`
            SELECT COUNT(*) AS total FROM picks
        `).get().total || 0;

        const success = this.db.prepare(`
            SELECT COUNT(*) AS success FROM picks WHERE status = 'success'
        `).get().success || 0;

        const running = this.db.prepare(`
            SELECT COUNT(*) AS running FROM picks WHERE status = 'running'
        `).get().running || 0;

        const avgRow = this.db.prepare(`
            SELECT AVG(duration_s) AS avg_time
            FROM picks
            WHERE duration_s IS NOT NULL
        `).get();

        return {
            total,
            success,
            running,
            successRate: total > 0 ? success / total : 0,
            avgTime: avgRow.avg_time || 0
        };
    }
        getAllPicksForCsv() {
        return this.db.prepare(`
            SELECT
                id,
                object_id,
                slot_id,
                object_angle,
                tray_servo_angle,
                pick_x,
                pick_y,
                pick_z,
                drop_x,
                drop_y,
                drop_z,
                image_path,
                status,
                error,
                started_at,
                finished_at,
                duration_s
            FROM picks
            ORDER BY id ASC
        `).all();
    }    
}

module.exports = LogService;
