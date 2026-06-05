# History Storage Setup

The history feature is designed so the database and captured object images can
live on a central server or NAS instead of a personal workstation.

## Environment variables

Backend:

```powershell
$env:ROBOT_DB_PATH="D:\DeltaRobotData\robot.db"
$env:ROBOT_IMAGE_ROOT="D:\DeltaRobotData\captures"
$env:VISION_BASE_URL="http://127.0.0.1:8000"
```

Vision service:

```powershell
$env:VISION_CAPTURE_DIR="D:\DeltaRobotData\captures"
$env:VISION_CAPTURE_URL_PREFIX="captures"
```

`ROBOT_IMAGE_ROOT` and `VISION_CAPTURE_DIR` should point to the same storage
folder when both services run on one machine. If they run on different
machines, point both variables to the same shared/NAS path.

## Export format

Use `/api/export/picks.zip` or the History tab's export button. The ZIP package
contains:

- `picks.csv`: pick records with an `image_file` column.
- `images/`: real image files embedded in the export package.
- `manifest.json`: export timestamp, row count, image count, and missing-image
  diagnostics.

The export package does not depend on localhost links.
