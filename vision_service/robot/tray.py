# vision_service/robot/tray.py

import math
from config import (
    TRAY_CENTER,
    TRAY_SLOTS_LOCAL,
    TRAY_SERVO_OFFSET,
    TRAY_SERVO_MIN,
    TRAY_SERVO_MAX,
)


def convert_object_angle_to_tray_servo(object_angle):
    """
    Chuyển góc vật sang góc servo khay.

    Công thức này ban đầu lấy theo code cũ:
        nếu angle > 0: servo = 180 - angle
        nếu angle <= 0: servo = abs(angle)

    Sau này nếu thực tế lệch, chỉnh thêm TRAY_SERVO_OFFSET.
    """
    if object_angle > 0:
        servo_angle = 180.0 - object_angle
    else:
        servo_angle = abs(object_angle)

    servo_angle += TRAY_SERVO_OFFSET

    while servo_angle < 0:
        servo_angle += 180.0

    while servo_angle > 180.0:
        servo_angle -= 180.0

    if servo_angle < TRAY_SERVO_MIN:
        servo_angle = TRAY_SERVO_MIN

    if servo_angle > TRAY_SERVO_MAX:
        servo_angle = TRAY_SERVO_MAX

    return servo_angle


def get_drop_pos_for_slot(slot_id, tray_angle_deg):
    """
    Tính tọa độ thật của ô thả trong hệ robot,
    dựa trên slot cục bộ của khay và góc quay khay.
    """
    if slot_id not in TRAY_SLOTS_LOCAL:
        raise ValueError(f"Invalid slot_id: {slot_id}")

    xc, yc, zc = TRAY_CENTER
    dx, dy = TRAY_SLOTS_LOCAL[slot_id]

    theta = math.radians(tray_angle_deg)

    x_drop = xc + dx * math.cos(theta) - dy * math.sin(theta)
    y_drop = yc + dx * math.sin(theta) + dy * math.cos(theta)
    z_drop = zc

    return x_drop, y_drop, z_drop