import argparse
import os
import time
from datetime import datetime

import cv2

from vision.camera_receiver import CameraReceiver


def make_capture_path(output_dir):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    return os.path.join(output_dir, f"ras_capture_{stamp}.jpg")


def main():
    parser = argparse.ArgumentParser(
        description="Show Raspberry Pi camera stream and save frames with Space."
    )
    parser.add_argument(
        "--out",
        default="images",
        help="Folder to save images. Default: images",
    )
    parser.add_argument(
        "--window",
        default="Raspberry Camera",
        help="OpenCV window title.",
    )
    args = parser.parse_args()

    output_dir = os.path.abspath(args.out)
    os.makedirs(output_dir, exist_ok=True)

    camera = CameraReceiver()
    last_frame = None
    last_message_time = 0.0

    print(f"[INFO] Saving images to: {output_dir}")
    print("[INFO] Press Space to capture. Press Q or Esc to quit.")

    cv2.namedWindow(args.window, cv2.WINDOW_NORMAL)

    while True:
        frame = camera.receive_frame()

        if frame is not None:
            last_frame = frame
            cv2.imshow(args.window, frame)
        else:
            now = time.time()
            if now - last_message_time > 2.0:
                err = camera.last_error or "waiting for Raspberry stream"
                print(f"[WAIT] {err}")
                last_message_time = now

        key = cv2.waitKey(1) & 0xFF

        if key == 27 or key == ord("q"):
            break

        if key == 32:
            if last_frame is None:
                print("[WARN] No frame available yet.")
                continue

            path = make_capture_path(output_dir)
            ok = cv2.imwrite(path, last_frame)
            if ok:
                print(f"[CAPTURE] {path}")
            else:
                print(f"[ERROR] Failed to save: {path}")

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
