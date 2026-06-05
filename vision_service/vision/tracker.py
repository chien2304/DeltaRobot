# vision_service/vision/tracker.py

import os
import cv2
import time
import json
import numpy as np
import contextlib
from datetime import datetime

from config import (
    STABLE_FRAMES,
    PIXEL_TO_MM,
    CENTER_X,
    CENTER_Y,
    Z_CONVEYOR,
    CAPTURE_DIR,
    CAPTURE_URL_PREFIX,
)


class ObjectTracker:
    def __init__(self):
        self.old_list = []
        self.main_list = []
        self.queue = []
        self.sequence_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            "data",
            "object_sequence.json",
        )
        self.next_object_id = self._load_next_object_id()
        self.last_detections_count = 0
        self.last_queue_event = None

        os.makedirs(CAPTURE_DIR, exist_ok=True)

    def _load_next_object_id(self):
        try:
            with open(self.sequence_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return max(1, int(data.get("next_object_id", 1)))
        except Exception:
            return 1

    def _save_next_object_id(self):
        os.makedirs(os.path.dirname(self.sequence_path), exist_ok=True)
        tmp_path = self.sequence_path + ".tmp"

        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"next_object_id": self.next_object_id}, f, indent=2)

        os.replace(tmp_path, self.sequence_path)

    def _allocate_object_id(self):
        object_id = self.next_object_id
        self.next_object_id += 1
        self._save_next_object_id()
        return object_id

    def pixel_to_robot_coords(self, cx, cy):
        x_robot = cy * PIXEL_TO_MM + CENTER_X
        y_robot = cx * PIXEL_TO_MM + CENTER_Y
        z_robot = Z_CONVEYOR

        return x_robot, y_robot, z_robot

    def update(self, detections, frame):
        """
        Cập nhật danh sách vật.
        Nếu vật ổn định đủ STABLE_FRAMES thì đưa vào queue.
        """
        self.last_detections_count = len(detections)

        if not self.main_list:
            for item in detections:
                item["count"] = 1
                item["angle_history"] = [item["angle"]]

            self.main_list = detections
            self.old_list = detections
            return

        y_max_old = self.old_list[-1]["cy"] if self.old_list else 0
        in_items_count = sum(
            1 for item in detections
            if item["cy"] > y_max_old + 8
        )

        match_count = len(detections) - in_items_count
        out_count = len(self.main_list) - match_count

        if out_count > 0:
            self.main_list = self.main_list[out_count:]

        for i in range(min(len(self.main_list), match_count)):
            if self.main_list[i]["count"] < STABLE_FRAMES:
                self.main_list[i].setdefault(
                    "angle_history",
                    [self.main_list[i]["angle"]]
                )

                self.main_list[i]["angle_history"].append(detections[i]["angle"])
                self.main_list[i]["cx"] = detections[i]["cx"]
                self.main_list[i]["cy"] = detections[i]["cy"]
                self.main_list[i]["bbox"] = detections[i]["bbox"]
                self.main_list[i]["confidence"] = detections[i]["confidence"]
                self.main_list[i]["detected_at"] = detections[i]["detected_at"]
                self.main_list[i]["count"] += 1

                if self.main_list[i]["count"] == STABLE_FRAMES:
                    self._push_stable_object(self.main_list[i], frame)
                    self.main_list[i]["count"] = STABLE_FRAMES + 1

        new_items = detections[-in_items_count:] if in_items_count > 0 else []

        for item in new_items:
            item["count"] = 1
            item["angle_history"] = [item["angle"]]
            self.main_list.append(item)

        self.old_list = detections

    def _push_stable_object(self, item, frame):
        angle = float(np.median(item["angle_history"]))
        x, y, z = self.pixel_to_robot_coords(item["cx"], item["cy"])

        object_id = self._allocate_object_id()

        image_path = self._save_object_image(object_id, item, frame)

        obj = {
            "object_id": object_id,
            "x": x,
            "y": y,
            "z": z,
            "angle": angle,
            "cx": item["cx"],
            "cy": item["cy"],
            "bbox": item["bbox"],
            "confidence": item.get("confidence", 0.0),
            "detected_at": item["detected_at"],
            "image_path": image_path,
            "status": "QUEUED",
        }

        self.queue.append(obj)
        self.last_queue_event = {
            "object_id": object_id,
            "queue_len": len(self.queue),
            "time": time.time(),
            "cx": item["cx"],
            "cy": item["cy"],
            "angle": angle,
        }

    def _save_object_image(self, object_id, item, frame):
        date_dir = datetime.now().strftime("%Y-%m-%d")
        save_dir = os.path.join(CAPTURE_DIR, date_dir)
        os.makedirs(save_dir, exist_ok=True)

        x1, y1, x2, y2 = item["bbox"]

        pad = 20
        h, w = frame.shape[:2]

        x1 = max(0, x1 - pad)
        y1 = max(0, y1 - pad)
        x2 = min(w, x2 + pad)
        y2 = min(h, y2 + pad)

        crop = frame[y1:y2, x1:x2]

        filename = f"object_{object_id:010d}.jpg"
        path = os.path.join(save_dir, filename)

        if crop.size > 0:
            cv2.imwrite(path, crop)

        return f"{CAPTURE_URL_PREFIX}/{date_dir}/{filename}".replace("\\", "/")

    def has_target(self):
        return len(self.queue) > 0

    def peek_next(self):
        if not self.queue:
            return None

        return self.queue[0]

    def pop_next(self):
        if not self.queue:
            return None

        return self.queue.pop(0)
    def discard_next(self, delete_image=True):
        """
        Bỏ vật đầu queue.
        Nếu delete_image=True thì xóa luôn ảnh crop đã lưu.
        Dùng khi vật đã ra ngoài tầm hoặc không thể tính IK.
        """
        if not self.queue:
            return None

        obj = self.queue.pop(0)

        if delete_image:
            image_path = obj.get("image_path")
            if image_path and os.path.exists(image_path):
                with contextlib.suppress(Exception):
                    os.remove(image_path)

        return obj
    def queue_len(self):
        return len(self.queue)

    def debug_status(self):
        return {
            "detections": self.last_detections_count,
            "tracked": len(self.main_list),
            "queue_len": len(self.queue),
            "stable_frames_required": STABLE_FRAMES,
            "candidates": [
                {
                    "cx": item.get("cx"),
                    "cy": item.get("cy"),
                    "count": item.get("count", 0),
                    "angle": item.get("angle"),
                    "confidence": item.get("confidence", 0.0),
                }
                for item in self.main_list
            ],
            "last_queue_event": self.last_queue_event,
        }
