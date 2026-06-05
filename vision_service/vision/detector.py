# vision_service/vision/detector.py

import cv2
import math
import os
import time
import numpy as np

os.environ.setdefault(
    "YOLO_CONFIG_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "ultralytics_config"))
)
os.makedirs(os.environ["YOLO_CONFIG_DIR"], exist_ok=True)

from ultralytics import YOLO

from config import (
    ROI_X1, ROI_Y1, ROI_X2, ROI_Y2,
    MARGIN_Y,
    LOWER_WHITE, UPPER_WHITE,
    YOLO_MODEL_PATH,
)


class VisionDetector:
    def __init__(self):
        self.model = YOLO(YOLO_MODEL_PATH, task="detect")
        self.lower_white = np.array(LOWER_WHITE)
        self.upper_white = np.array(UPPER_WHITE)

        self.roi = {
            "x1": ROI_X1,
            "y1": ROI_Y1,
            "x2": ROI_X2,
            "y2": ROI_Y2,
        }

    def set_roi(self, x1, y1, x2, y2):
        self.roi = {
            "x1": int(x1),
            "y1": int(y1),
            "x2": int(x2),
            "y2": int(y2),
        }

    def get_roi(self):
        return dict(self.roi)

    def process_detections(self, frame):
        """
        Trả về list vật tìm được:
        [
            {
                "cx": ...,
                "cy": ...,
                "angle": ...,
                "bbox": [x1, y1, x2, y2],
                "confidence": ...,
                "detected_at": ...
            }
        ]
        """
        results = self.model.predict(frame, conf=0.7, verbose=False)
        current_list = []

        for result in results:
            for box in result.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                conf = float(box.conf[0]) if box.conf is not None else 0.0

                rx1 = self.roi["x1"]
                ry1 = self.roi["y1"]
                rx2 = self.roi["x2"]
                ry2 = self.roi["y2"]

                if (
                    y1 < ry1 + MARGIN_Y or
                    y2 > ry2 - MARGIN_Y or
                    x1 < rx1 + MARGIN_Y or
                    x2 > rx2 - MARGIN_Y
                ):
                    continue

                roi = frame[y1:y2, x1:x2]
                if roi.size == 0:
                    continue

                angle = self._estimate_angle_from_roi(roi, x1, y1, x2, y2)
                if angle is None:
                    continue

                cx = int((x1 + x2) / 2)
                cy = int((y1 + y2) / 2)

                current_list.append({
                    "cx": cx,
                    "cy": cy,
                    "angle": round(angle, 1),
                    "bbox": [x1, y1, x2, y2],
                    "confidence": conf,
                    "detected_at": time.time(),
                })

        current_list.sort(key=lambda item: item["cy"])
        return current_list

    def _estimate_angle_from_roi(self, roi, x1, y1, x2, y2):
        """
        Giữ gần giống code cũ:
        HSV trắng -> contour -> fitLine -> angle.
        """
        roi_blur = cv2.medianBlur(roi, 3)
        roi_hsv = cv2.cvtColor(roi_blur, cv2.COLOR_BGR2HSV)

        mask = cv2.inRange(roi_hsv, self.lower_white, self.upper_white)

        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        contours, _ = cv2.findContours(
            mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )

        if not contours:
            return None

        cnt = max(contours, key=cv2.contourArea)

        epsilon = 0.08 * cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, epsilon, True)

        if len(approx) < 2:
            return None

        approx_global = approx + [x1, y1]
        pts = approx_global.reshape(-1, 2).astype(np.float32)

        vx, vy, _, _ = cv2.fitLine(
            pts,
            cv2.DIST_L2,
            0,
            0.01,
            0.01
        )

        angle_deg = math.degrees(math.atan2(float(vy), float(vx))) % 180

        if angle_deg > 90:
            angle_deg -= 180

        bw = x2 - x1
        bh = y2 - y1

        if (bh > bw) != (abs(angle_deg) > 45):
            angle_deg += 90

            if angle_deg > 90:
                angle_deg -= 180

            if angle_deg < -90:
                angle_deg += 180

        return angle_deg
