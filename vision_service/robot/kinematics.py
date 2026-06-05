# vision_service/robot/kinematics.py

import math
import numpy as np
from config import L, l, R, r

sqrt3 = math.sqrt(3.0)
sin120 = sqrt3 / 2.0
cos120 = -0.5
sin240 = -sqrt3 / 2.0
cos240 = -0.5


def calculate_theta(x0, y0, z0):
    if z0 == 0:
        z0 = -0.001

    y1 = y0 - (R - r)
    a = (x0**2 + y1**2 + z0**2 + L**2 - l**2) / (2 * z0)
    b = -y1 / z0

    A = b**2 + 1
    B = 2 * a * b
    C = a**2 - L**2

    delta = B**2 - 4 * A * C
    if delta < 0:
        return None

    yj = (-B + math.sqrt(delta)) / (2 * A)
    zj = a + b * yj

    return math.atan2(-zj, yj) * 180.0 / math.pi


def delta_ik(x, y, z):
    t1 = calculate_theta(x, y, z)
    t2 = calculate_theta(
        x * cos120 + y * sin120,
        y * cos120 - x * sin120,
        z
    )
    t3 = calculate_theta(
        x * cos240 + y * sin240,
        y * cos240 - x * sin240,
        z
    )

    if None in (t1, t2, t3):
        return None

    return np.array([t1, t2, t3])


def ik_point(pos):
    result = delta_ik(*pos)
    if result is None:
        return (None, None, None)

    return float(result[0]), float(result[1]), float(result[2])