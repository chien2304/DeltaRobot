# vision_service/robot/trajectory.py

import math
from config import (
    Z_SAFE_PICK,
    Z_SAFE_DROP,
    HE_SO_GAP,
    HE_SO_THA,
    CONVEYOR_SPEED,
    UART_DELAY,
    SERVO_SETTLE_DELAY,
    SERVO_SECOND_SETTLE_DELAY,
    DELAY_BEFORE_GAP,
    BLEND_ALPHA,
)
from robot.kinematics import ik_point


def lerp3(p1, p2, t):
    return (
        p1[0] + t * (p2[0] - p1[0]),
        p1[1] + t * (p2[1] - p1[1]),
        p1[2] + t * (p2[2] - p1[2]),
    )


def blend_corner(p_prev, p_corner, p_next, alpha=BLEND_ALPHA):
    b_in = lerp3(p_corner, p_prev, alpha)
    b_out = lerp3(p_corner, p_next, alpha)
    return b_in, b_out


def path_length_3d(poses):
    total = 0.0

    for i in range(1, len(poses)):
        dx = poses[i][0] - poses[i - 1][0]
        dy = poses[i][1] - poses[i - 1][1]
        dz = poses[i][2] - poses[i - 1][2]
        total += math.sqrt(dx * dx + dy * dy + dz * dz)

    return total


def build_pick_poses(x_robot, y_robot, z_robot, x_est, y_now, z_now):
    p_est = (x_est, y_now, z_now)
    p_est_up = (x_est, y_now, z_now + Z_SAFE_PICK)
    p_robot_up = (x_robot, y_robot, z_now + Z_SAFE_PICK)
    p_robot = (x_robot, y_robot, z_robot)

    if z_now - z_robot > Z_SAFE_PICK:
        p_corner = (x_est, y_now, z_now)
        b_in, b_out = blend_corner(p_robot, p_corner, p_est)
        return [b_in, b_out, p_est]

    b1_in, b1_out = blend_corner(p_robot, p_robot_up, p_est_up)
    b2_in, b2_out = blend_corner(p_robot_up, p_est_up, p_est)

    return [b1_in, b1_out, b2_in, b2_out, p_est]


def build_drop_poses(p_est, p_est_up, drop_pos):
    x_drop, y_drop, z_drop = drop_pos

    p_drop = (x_drop, y_drop, z_drop)
    p_drop_up = (x_drop, y_drop, z_drop + Z_SAFE_DROP)

    b1_in, b1_out = blend_corner(p_est, p_est_up, p_drop_up)
    b2_in, b2_out = blend_corner(p_est_up, p_drop_up, p_drop)

    return [b1_in, b1_out, b2_in, b2_out, p_drop]


def calculate_move(x_now, y_now, z_now, x_robot, y_robot, z_robot, drop_pos):
    """
    Tính quỹ đạo từ robot hiện tại -> vật -> ô thả.

    Trả về:
        waypoints, num_pick, t_pick, t_drop
    """
    dist_approx = math.sqrt(
        (x_now - x_robot) ** 2 +
        (y_now - y_robot) ** 2 +
        (z_now - z_robot) ** 2
    )

    pick_start_delay = UART_DELAY + SERVO_SETTLE_DELAY + SERVO_SECOND_SETTLE_DELAY + DELAY_BEFORE_GAP

    t_approx = dist_approx / HE_SO_GAP
    x_est_check = x_now - (t_approx + pick_start_delay) * CONVEYOR_SPEED

    if x_est_check < -80:
        return {
            "ok": False,
            "reason": "OBJECT_TOO_FAR"
        }

    if x_est_check > 50:
        return {
            "ok": False,
            "reason": "OBJECT_NOT_READY"
        }

    pick_poses = build_pick_poses(
        x_robot, y_robot, z_robot,
        x_est_check, y_now, z_now
    )

    dist_pick = path_length_3d([(x_robot, y_robot, z_robot)] + pick_poses)
    t_pick = dist_pick / HE_SO_GAP

    x_est = x_now - (t_pick + pick_start_delay) * CONVEYOR_SPEED

    pick_poses = build_pick_poses(
        x_robot, y_robot, z_robot,
        x_est, y_now, z_now
    )

    p_est = (x_est, y_now, z_now)
    p_est_up = (x_est, y_now, z_now + Z_SAFE_PICK)

    drop_poses = build_drop_poses(p_est, p_est_up, drop_pos)

    dist_drop = path_length_3d([p_est] + drop_poses)
    t_drop = dist_drop / HE_SO_THA

    def wp(label, pos):
        return {
            "angles": ik_point(pos),
            "label": label,
            "pos": pos,
        }

    pick_wps = [wp(f"pick_{i}", p) for i, p in enumerate(pick_poses)]
    drop_wps = [wp(f"drop_{i}", p) for i, p in enumerate(drop_poses)]

    waypoints = pick_wps + drop_wps
    num_pick = len(pick_wps)

    return {
        "ok": True,
        "waypoints": waypoints,
        "num_pick": num_pick,
        "t_pick": t_pick,
        "t_drop": t_drop,
        "x_est": x_est,
        "pick_pos": [x_est, y_now, z_now],
    }
