// web_backend/services/historyExportService.js

const ZipWriter = require("./zipWriter");

const EXPORT_COLUMNS = [
    "id",
    "object_id",
    "slot_id",
    "object_angle",
    "tray_servo_angle",
    "pick_x",
    "pick_y",
    "pick_z",
    "drop_x",
    "drop_y",
    "drop_z",
    "image_file",
    "status",
    "error",
    "started_at",
    "finished_at",
    "duration_s"
];

function escapeCsv(value) {
    if (value === null || value === undefined) return "";
    return `"${String(value).replace(/"/g, '""')}"`;
}

function rowsToCsv(rows) {
    const lines = [
        EXPORT_COLUMNS.join(","),
        ...rows.map(row => EXPORT_COLUMNS.map(key => escapeCsv(row[key])).join(","))
    ];

    return "\uFEFF" + lines.join("\n");
}

function buildHistoryZip(rows, imageService) {
    const zip = new ZipWriter();
    const exportRows = [];
    const manifest = {
        exported_at: new Date().toISOString(),
        row_count: rows.length,
        image_count: 0,
        missing_images: []
    };

    for (const row of rows) {
        const resolvedImage = imageService.resolve(row);
        const imageFile = resolvedImage ? resolvedImage.archivePath : "";

        exportRows.push({
            ...row,
            image_file: imageFile
        });

        if (resolvedImage) {
            zip.addFile(resolvedImage.archivePath, resolvedImage.absolutePath);
            manifest.image_count += 1;
        } else if (row.image_path) {
            manifest.missing_images.push({
                pick_id: row.id,
                object_id: row.object_id,
                original_image_path: row.image_path
            });
        }
    }

    zip.addText("picks.csv", rowsToCsv(exportRows));
    zip.addText("manifest.json", JSON.stringify(manifest, null, 2));

    return zip.toBuffer();
}

module.exports = {
    buildHistoryZip,
    rowsToCsv,
};
