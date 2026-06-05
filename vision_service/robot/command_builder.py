# vision_service/robot/command_builder.py

from config import SERVO_SETTLE_DELAY, SERVO_SECOND_SETTLE_DELAY, DELAY_BEFORE_GAP


def angle_distance(a1, a2):
    if None in a1 or None in a2:
        return 1.0

    return max(abs(a1[k] - a2[k]) for k in range(3)) + 0.01


def allocate_times(waypoints, start_i, end_i, total_t):
    count = end_i - start_i + 1

    if count <= 0:
        return []

    if count == 1:
        return [total_t]

    dists = [
        angle_distance(
            waypoints[start_i + k]["angles"],
            waypoints[start_i + k + 1]["angles"]
        )
        for k in range(count - 1)
    ]

    dists = [dists[0]] + dists
    total_d = sum(dists)

    if total_d == 0:
        return [total_t / count] * count

    return [total_t * d / total_d for d in dists]


def fmt_angle(value):
    value = round(float(value), 1)

    if abs(value) < 0.05:
        value = 0.0

    if value.is_integer():
        return str(int(value))

    return f"{value:.1f}"


def fmt_ms(seconds):
    return str(max(1, int(round(float(seconds) * 1000.0))))


def build_uart_command(command_id, waypoints, num_pick, t_pick, t_drop, tray_servo_angle):
    """
    Format UART gửi xuống ATmega.

    Dạng mới tạm thời:
        S|ID<n>|G<angle>|waypoints...|D150|E|V1|D300|V0

    Nếu firmware cũ chưa parse ID, ta có thể tắt ID bằng cách bỏ token ID.
    """
    n = len(waypoints)

    pick_times = allocate_times(waypoints, 0, num_pick - 1, t_pick)
    drop_times = allocate_times(waypoints, num_pick, n - 1, t_drop)
    all_times = pick_times + drop_times

    parts = ["S"]
    parts.append(f"ID{command_id}")

    parts.append(f"G{fmt_angle(tray_servo_angle)}")
    parts.append(f"D{fmt_ms(SERVO_SETTLE_DELAY)}")
    parts.append(f"G{fmt_angle(tray_servo_angle)}")
    parts.append(f"D{fmt_ms(SERVO_SECOND_SETTLE_DELAY)}")

    for i, wp in enumerate(waypoints):
        angles = wp["angles"]
        pos = wp["pos"]
        label = wp["label"]

        if None in angles:
            return {
                "ok": False,
                "reason": f"IK_ERROR at {label}: {pos}"
            }

        parts.append(",".join(fmt_angle(a) for a in angles))
        parts.append(f"T{fmt_ms(all_times[i])}")
        if i == num_pick - 2:
            parts.append(f"D{fmt_ms(DELAY_BEFORE_GAP)}")
        if i == num_pick - 1:
            parts.append("E")
            parts.append("D70")

    parts += ["E", "D70", "V1", "D500", "V0"]

    command = "|".join(parts) + "\n"

    if len(command.rstrip("\n")) > 255:
        return {
            "ok": False,
            "reason": f"UART_COMMAND_TOO_LONG: {len(command.rstrip(chr(10)))} chars"
        }

    return {
        "ok": True,
        "command": command
    }
