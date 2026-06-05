# vision_service/app.py

import time
import threading
import cv2
import os
import json
from flask import Flask, jsonify, request, Response, send_from_directory
import config
import robot.kinematics as kinematics_module
import robot.trajectory as trajectory_module
import robot.tray as tray_module
import vision.tracker as tracker_module

from config import (
    ROI_X1, ROI_Y1, ROI_X2, ROI_Y2,
    CONVEYOR_SPEED,
)

from vision.camera_receiver import CameraReceiver
from vision.detector import VisionDetector
from vision.tracker import ObjectTracker

from robot.tray import (
    convert_object_angle_to_tray_servo,
    get_drop_pos_for_slot,
)

from robot.trajectory import calculate_move
from robot.command_builder import build_uart_command


app = Flask(__name__)
RUNTIME_CONFIG_PATH = "config_runtime.json"

ALLOWED_SETTINGS = {
    "L": float,
    "l": float,
    "R": float,
    "r": float,

    "CONVEYOR_SPEED": float,
    "UART_DELAY": float,

    "Z_CONVEYOR": float,
    "CENTER_X": float,
    "CENTER_Y": float,

    "STABLE_FRAMES": int,

    "Z_SAFE_PICK": float,
    "Z_SAFE_DROP": float,

    "HE_SO_GAP": float,
    "HE_SO_THA": float,
    "BLEND_ALPHA": float,

    "TRAY_CENTER": list,
    "TRAY_SERVO_OFFSET": float,
}


def load_runtime_settings():
    if not os.path.exists(RUNTIME_CONFIG_PATH):
        return {}

    with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_runtime_settings(data):
    with open(RUNTIME_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
def apply_runtime_settings_to_modules(settings):
    """
    Áp dụng settings mới vào các module đang chạy.
    Như vậy Save Settings trên web có tác dụng ngay,
    không cần restart Vision Service.
    """

    # ---------- config module ----------
    for key in [
        "L", "l", "R", "r",
        "CONVEYOR_SPEED", "UART_DELAY",
        "Z_CONVEYOR", "CENTER_X", "CENTER_Y",
        "STABLE_FRAMES",
        "Z_SAFE_PICK", "Z_SAFE_DROP",
        "HE_SO_GAP", "HE_SO_THA", "BLEND_ALPHA",
        "TRAY_SERVO_OFFSET"
    ]:
        if key in settings:
            setattr(config, key, settings[key])

    if "TRAY_CENTER" in settings:
        config.TRAY_CENTER = tuple(settings["TRAY_CENTER"])

    # ---------- kinematics ----------
    if "L" in settings:
        kinematics_module.L = float(settings["L"])
    if "l" in settings:
        kinematics_module.l = float(settings["l"])
    if "R" in settings:
        kinematics_module.R = float(settings["R"])
    if "r" in settings:
        kinematics_module.r = float(settings["r"])

    # ---------- trajectory ----------
    for key in [
        "Z_SAFE_PICK",
        "Z_SAFE_DROP",
        "HE_SO_GAP",
        "HE_SO_THA",
        "CONVEYOR_SPEED",
        "UART_DELAY",
        "BLEND_ALPHA"
    ]:
        if key in settings:
            setattr(trajectory_module, key, settings[key])

    # ---------- tray ----------
    if "TRAY_CENTER" in settings:
        tray_module.TRAY_CENTER = tuple(settings["TRAY_CENTER"])

    if "TRAY_SERVO_OFFSET" in settings:
        tray_module.TRAY_SERVO_OFFSET = float(settings["TRAY_SERVO_OFFSET"])

    # ---------- tracker ----------
    if "STABLE_FRAMES" in settings:
        tracker_module.STABLE_FRAMES = int(settings["STABLE_FRAMES"])

    if "CENTER_X" in settings:
        tracker_module.CENTER_X = float(settings["CENTER_X"])

    if "CENTER_Y" in settings:
        tracker_module.CENTER_Y = float(settings["CENTER_Y"])

    if "Z_CONVEYOR" in settings:
        tracker_module.Z_CONVEYOR = float(settings["Z_CONVEYOR"])

    # ---------- app.py global ----------
    global CONVEYOR_SPEED
    if "CONVEYOR_SPEED" in settings:
        CONVEYOR_SPEED = float(settings["CONVEYOR_SPEED"])
camera = CameraReceiver()
detector = VisionDetector()
tracker = ObjectTracker()

is_vision_running = False

# Robot position do backend truyền sang khi gọi plan.
# Ở đây chỉ lưu để hiển thị.
last_robot_pos = [0.0, 0.0, -180.0]

# Frame đã vẽ annotation để stream.
output_frame = None
frame_lock = threading.Lock()


def draw_annotations(frame, detections):
    img = frame.copy()

    roi = detector.get_roi()

    cv2.rectangle(
        img,
        (roi["x1"], roi["y1"]),
        (roi["x2"], roi["y2"]),
        (0, 0, 255),
        2
    )

    for item in detections:
        cx = item["cx"]
        cy = item["cy"]
        angle = item["angle"]
        x1, y1, x2, y2 = item["bbox"]

        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 180, 255), 2)
        cv2.circle(img, (cx, cy), 5, (0, 0, 255), -1)
        cv2.putText(
            img,
            f"A:{angle:.1f}",
            (cx + 8, cy - 8),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 0),
            1
        )

    return img


def camera_loop():
    global output_frame

    while True:
        frame = camera.receive_frame()

        if frame is None:
            time.sleep(0.02)
            continue

        detections = []

        if is_vision_running:
            detections = detector.process_detections(frame)
            tracker.update(detections, frame)

        annotated = draw_annotations(frame, detections)

        with frame_lock:
            output_frame = annotated

        time.sleep(0.01)


@app.route("/api/status", methods=["GET"])
def api_status():
    return jsonify({
        "ok": True,
        "vision_running": is_vision_running,
        "video_ready": camera.video_ready,
        "queue_len": tracker.queue_len(),
        "tracker": tracker.debug_status(),
        "conveyor_speed": CONVEYOR_SPEED,
        "last_robot_pos": last_robot_pos,
        "camera_error": camera.last_error,
    })

@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify({
        "ok": True,
        "settings": load_runtime_settings(),
        "need_restart_after_save": False
    })


@app.route("/api/settings", methods=["POST"])
def api_save_settings():
    data = request.get_json(force=True)
    current = load_runtime_settings()

    for key, caster in ALLOWED_SETTINGS.items():
        if key not in data:
            continue

        value = data[key]

        try:
            if key == "TRAY_CENTER":
                if not isinstance(value, list) or len(value) != 3:
                    return jsonify({
                        "ok": False,
                        "error": "TRAY_CENTER must be [x, y, z]"
                    }), 400

                current[key] = [
                    float(value[0]),
                    float(value[1]),
                    float(value[2])
                ]
            else:
                current[key] = caster(value)

        except Exception:
            return jsonify({
                "ok": False,
                "error": f"Invalid value for {key}"
            }), 400

    save_runtime_settings(current)
    apply_runtime_settings_to_modules(current)

    return jsonify({
        "ok": True,
        "settings": current,
        "applied_runtime": True,
        "need_restart": False
    })

@app.route("/api/start-vision", methods=["POST"])
def api_start_vision():
    global is_vision_running
    is_vision_running = True
    return jsonify({
        "ok": True,
        "vision_running": is_vision_running
    })


@app.route("/api/stop-vision", methods=["POST"])
def api_stop_vision():
    global is_vision_running
    is_vision_running = False
    return jsonify({
        "ok": True,
        "vision_running": is_vision_running
    })


@app.route("/api/plan-next-pick", methods=["POST"])
def api_plan_next_pick():
    """
    Backend gọi API này khi robot sẵn sàng.

    Body:
    {
        "slot_id": 1,
        "robot_pos": [0.0, 0.0, -180.0],
        "command_id": 1
    }
    """
    global last_robot_pos

    data = request.get_json(force=True)

    slot_id = int(data.get("slot_id", 1))
    robot_pos = data.get("robot_pos", [0.0, 0.0, -180.0])
    command_id = int(data.get("command_id", int(time.time())))

    last_robot_pos = robot_pos

    x_robot, y_robot, z_robot = robot_pos

    # Thử bỏ qua vài vật lỗi trong cùng một lần backend hỏi.
    # Tránh trường hợp queue bị kẹt ở một vật ngoài tầm.
    max_discard = 10
    discarded = []

    for _ in range(max_discard):
        target = tracker.peek_next()

        if target is None:
            return jsonify({
                "ok": False,
                "reason": "NO_TARGET",
                "queue_len": tracker.queue_len(),
                "discarded": discarded,
            })

        x_now = target["x"] - (time.time() - target["detected_at"]) * CONVEYOR_SPEED
        y_now = target["y"]
        z_now = target["z"]

        tray_servo_angle = convert_object_angle_to_tray_servo(target["angle"])
        drop_pos = get_drop_pos_for_slot(slot_id, tray_servo_angle)

        plan = calculate_move(
            x_now=x_now,
            y_now=y_now,
            z_now=z_now,
            x_robot=x_robot,
            y_robot=y_robot,
            z_robot=z_robot,
            drop_pos=drop_pos,
        )

        if not plan["ok"]:
            reason = plan["reason"]

            # Vật chưa tới vùng gắp thì giữ lại, không pop.
            if reason == "OBJECT_NOT_READY":
                return jsonify({
                    "ok": False,
                    "reason": reason,
                    "object_id": target["object_id"],
                    "queue_len": tracker.queue_len(),
                    "discarded": discarded,
                })

            # Vật đã quá xa hoặc lỗi vị trí thì bỏ luôn để không kẹt queue.
            removed = tracker.discard_next(delete_image=True)
            discarded.append({
                "object_id": removed["object_id"] if removed else None,
                "reason": reason
            })

            continue

        cmd_result = build_uart_command(
            command_id=command_id,
            waypoints=plan["waypoints"],
            num_pick=plan["num_pick"],
            t_pick=plan["t_pick"],
            t_drop=plan["t_drop"],
            tray_servo_angle=tray_servo_angle,
        )

        if not cmd_result["ok"]:
            reason = cmd_result["reason"]

            # Nếu lỗi IK hoặc command quá dài thì bỏ vật này để không kẹt queue.
            if (
                reason.startswith("IK_ERROR") or
                reason.startswith("UART_COMMAND_TOO_LONG")
            ):
                removed = tracker.discard_next(delete_image=True)
                discarded.append({
                    "object_id": removed["object_id"] if removed else None,
                    "reason": reason
                })
                continue

            return jsonify({
                "ok": False,
                "reason": reason,
                "object_id": target["object_id"],
                "queue_len": tracker.queue_len(),
                "discarded": discarded,
            })

        # Plan thành công thì pop vật này để không dùng lại.
        tracker.pop_next()

        return jsonify({
            "ok": True,
            "object_id": target["object_id"],
            "command_id": command_id,
            "slot_id": slot_id,
            "object_angle": target["angle"],
            "tray_servo_angle": tray_servo_angle,
            "pick_pos": plan["pick_pos"],
            "drop_pos": list(drop_pos),
            "image_path": target["image_path"],
            "uart_command": cmd_result["command"],
            "queue_len": tracker.queue_len(),
            "discarded": discarded,
        })

    return jsonify({
        "ok": False,
        "reason": "TOO_MANY_INVALID_TARGETS",
        "queue_len": tracker.queue_len(),
        "discarded": discarded,
    })


@app.route("/video_feed")
def video_feed():
    def generate():
        while True:
            with frame_lock:
                if output_frame is None:
                    jpeg = camera.get_latest_jpeg()
                else:
                    _, buffer = cv2.imencode(".jpg", output_frame)
                    jpeg = buffer.tobytes()

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n" +
                jpeg +
                b"\r\n"
            )

            time.sleep(0.04)

    return Response(
        generate(),
        mimetype="multipart/x-mixed-replace; boundary=frame"
    )


@app.route("/captures/<path:filename>")
def get_capture(filename):
    return send_from_directory(config.CAPTURE_DIR, filename)

@app.route("/api/roi", methods=["GET"])
def api_get_roi():
    return jsonify({
        "ok": True,
        "roi": detector.get_roi()
    })


@app.route("/api/roi", methods=["POST"])
def api_set_roi():
    data = request.get_json(force=True)

    try:
        x1 = int(data.get("x1"))
        y1 = int(data.get("y1"))
        x2 = int(data.get("x2"))
        y2 = int(data.get("y2"))
    except Exception:
        return jsonify({
            "ok": False,
            "error": "INVALID_ROI_VALUE"
        }), 400

    if x2 <= x1 or y2 <= y1:
        return jsonify({
            "ok": False,
            "error": "INVALID_ROI_SIZE"
        }), 400

    detector.set_roi(x1, y1, x2, y2)

    return jsonify({
        "ok": True,
        "roi": detector.get_roi()
    })
if __name__ == "__main__":
    threading.Thread(target=camera_loop, daemon=True).start()

    print("VISION_SERVICE_READY")
    app.run(host="127.0.0.1", port=8000, threaded=True)
