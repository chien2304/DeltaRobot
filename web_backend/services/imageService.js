// web_backend/services/imageService.js

const fs = require("fs");
const path = require("path");

class ImageService {
    constructor() {
        this.imageRoot = path.resolve(
            process.env.ROBOT_IMAGE_ROOT ||
            path.join(__dirname, "..", "..", "vision_service", "captures")
        );
    }

    publicUrlForPick(row) {
        if (!row || !row.id || !row.image_path) return "";
        return `/api/picks/${row.id}/image`;
    }

    resolve(row) {
        if (!row || !row.image_path) return null;

        const rawPath = String(row.image_path).replace(/\\/g, "/");
        let relativePath = rawPath.replace(/^\/+/, "");

        if (relativePath.startsWith("captures/")) {
            relativePath = relativePath.slice("captures/".length);
        }

        if (path.isAbsolute(rawPath)) {
            const absolutePath = path.resolve(rawPath);
            if (!fs.existsSync(absolutePath)) return null;

            return {
                absolutePath,
                archivePath: this.archiveName(row, path.basename(absolutePath)),
            };
        }

        const absolutePath = path.resolve(this.imageRoot, ...relativePath.split("/"));
        if (!this.isInsideImageRoot(absolutePath) || !fs.existsSync(absolutePath)) {
            return null;
        }

        return {
            absolutePath,
            archivePath: this.archiveName(row, relativePath),
        };
    }

    archiveName(row, relativePath) {
        const cleanName = String(relativePath)
            .replace(/\\/g, "/")
            .split("/")
            .filter(Boolean)
            .join("_");

        const pickId = String(row.id).padStart(6, "0");
        return `images/pick_${pickId}_${cleanName || "object.jpg"}`;
    }

    isInsideImageRoot(absolutePath) {
        const rel = path.relative(this.imageRoot, absolutePath);
        return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    }
}

module.exports = ImageService;
