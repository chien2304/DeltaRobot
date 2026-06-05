# vision_service/vision/camera_receiver.py

import time
import cv2
import zmq
import imagezmq
import numpy as np


class CameraReceiver:
    def __init__(self):
        self.image_hub = None
        self.latest_frame = None
        self.video_ready = False
        self.last_error = None
        self.last_frame_time = 0
        self.camera_timeout_s = 3.0

    def connect(self):
        try:
            self.image_hub = imagezmq.ImageHub()
            self.image_hub.zmq_socket.setsockopt(zmq.CONFLATE, 1)
            self.image_hub.zmq_socket.setsockopt(zmq.RCVTIMEO, 2000)
            self.video_ready = False
            self.last_error = None
            return True
        except Exception as e:
            self.image_hub = None
            self.video_ready = False
            self.last_error = str(e)
            return False

    def receive_frame(self):
        if self.image_hub is None:
            ok = self.connect()
            if not ok:
                time.sleep(1)
                return None

        try:
            _, frame = self.image_hub.recv_image()
            self.image_hub.send_reply(b"OK")

            self.latest_frame = frame
            self.last_frame_time = time.time()
            self.video_ready = True
            self.last_error = None

            return frame

        except zmq.error.Again:
            if time.time() - self.last_frame_time > self.camera_timeout_s:
                self.video_ready = False
                self.latest_frame = None
            return None

        except Exception as e:
            self.video_ready = False
            self.latest_frame = None
            self.last_error = str(e)
            time.sleep(0.1)
            return None

    def get_latest_jpeg(self):
        if self.latest_frame is None:
            img = np.zeros((480, 640, 3), np.uint8)
            cv2.putText(
                img,
                "WAITING FOR CAMERA...",
                (130, 240),
                cv2.FONT_HERSHEY_SIMPLEX,
                1,
                (0, 0, 255),
                2
            )
            _, buffer = cv2.imencode(".jpg", img)
            return buffer.tobytes()

        _, buffer = cv2.imencode(".jpg", self.latest_frame)
        return buffer.tobytes()