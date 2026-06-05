# vision_service/config.py

import os

# -------------------------
# ROBOT GEOMETRY
# -------------------------
L = 130.0
l = 233.0
R = 46.942
r = 23.311

# -------------------------
# CONVEYOR
# -------------------------
CONVEYOR_SPEED = 57.5  # mm/s
UART_DELAY = 0.08      # s
SERVO_SETTLE_DELAY = 0.35  # s, delay after first tray servo angle command
SERVO_SECOND_SETTLE_DELAY = 0.08  # s, short delay after repeated servo angle command
DELAY_BEFORE_GAP= 0.1
# -------------------------
# CAMERA / ROI
# -------------------------
ROI_X1 = 205
ROI_Y1 = 70
ROI_X2 = 415
ROI_Y2 = 410
MARGIN_Y = 2

W_FIXED = 109.0
H_FIXED = 62.0
PIXEL_TO_MM = (35 / W_FIXED + 20 / H_FIXED) / 2

Z_CONVEYOR = -230.5
CENTER_X = 80
CENTER_Y = -153

# -------------------------
# DETECTION
# -------------------------
STABLE_FRAMES = 6

LOWER_WHITE = [0, 0, 225]
UPPER_WHITE = [180, 60, 255]

# -------------------------
# MOTION
# -------------------------
Z_SAFE_PICK = 20.0
Z_SAFE_DROP = 20.0

HE_SO_GAP = 90.0
HE_SO_THA = 90.0

BLEND_ALPHA = 0.40

# -------------------------
# TRAY
# -------------------------
TRAY_CENTER = (16.0, 53.0, -190.0)

# 2 tray slots in tray-local coordinates, measured from TRAY_CENTER.
# The coordinates are rotated by the tray servo angle before dropping.
TRAY_SLOTS_LOCAL = {
    1: (22.5,  0.0),
    2: ( -22.5, 0.0),
}

TRAY_SERVO_OFFSET = -3.0
TRAY_SERVO_MIN = 0.0
TRAY_SERVO_MAX = 180.0

# -------------------------
# MODEL
# -------------------------
YOLO_MODEL_PATH = "models/best_openvino_model"

# -------------------------
# CAPTURE
# -------------------------
CAPTURE_DIR = os.environ.get("VISION_CAPTURE_DIR", "captures")
CAPTURE_URL_PREFIX = os.environ.get("VISION_CAPTURE_URL_PREFIX", "captures")

# -------------------------
# RUNTIME CONFIG OVERRIDE
# -------------------------
import json

RUNTIME_CONFIG_PATH = "config_runtime.json"


def _apply_runtime_config():
    global L, l, R, r
    global CONVEYOR_SPEED, UART_DELAY
    global Z_CONVEYOR, CENTER_X, CENTER_Y
    global STABLE_FRAMES
    global Z_SAFE_PICK, Z_SAFE_DROP
    global HE_SO_GAP, HE_SO_THA, BLEND_ALPHA
    global TRAY_CENTER, TRAY_SERVO_OFFSET

    if not os.path.exists(RUNTIME_CONFIG_PATH):
        return

    try:
        with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)

        L = float(data.get("L", L))
        l = float(data.get("l", l))
        R = float(data.get("R", R))
        r = float(data.get("r", r))

        CONVEYOR_SPEED = float(data.get("CONVEYOR_SPEED", CONVEYOR_SPEED))
        UART_DELAY = float(data.get("UART_DELAY", UART_DELAY))

        Z_CONVEYOR = float(data.get("Z_CONVEYOR", Z_CONVEYOR))
        CENTER_X = float(data.get("CENTER_X", CENTER_X))
        CENTER_Y = float(data.get("CENTER_Y", CENTER_Y))

        STABLE_FRAMES = int(data.get("STABLE_FRAMES", STABLE_FRAMES))

        Z_SAFE_PICK = float(data.get("Z_SAFE_PICK", Z_SAFE_PICK))
        Z_SAFE_DROP = float(data.get("Z_SAFE_DROP", Z_SAFE_DROP))

        HE_SO_GAP = float(data.get("HE_SO_GAP", HE_SO_GAP))
        HE_SO_THA = float(data.get("HE_SO_THA", HE_SO_THA))
        BLEND_ALPHA = float(data.get("BLEND_ALPHA", BLEND_ALPHA))

        tray_center = data.get("TRAY_CENTER", TRAY_CENTER)
        if isinstance(tray_center, list) and len(tray_center) == 3:
            TRAY_CENTER = (
                float(tray_center[0]),
                float(tray_center[1]),
                float(tray_center[2])
            )

        TRAY_SERVO_OFFSET = float(data.get("TRAY_SERVO_OFFSET", TRAY_SERVO_OFFSET))

    except Exception as e:
        print(f"[CONFIG] Failed to apply runtime config: {e}")


_apply_runtime_config()
