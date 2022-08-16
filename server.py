import argparse
import asyncio
import json
import logging
import os
import ssl
import uuid

import cv2
from aiohttp import web
from av import VideoFrame

from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaBlackhole, MediaPlayer, MediaRecorder, MediaRelay

#socket.io
import socketio
#mediapipe!!
import math
import numpy as np
# import argparse
import timeit
import mediapipe as mp
from face_detection import face_detection
from mediapipe.framework.formats.detection_pb2 import Detection
from object_det_v2 import object_detection
from detection_processing import detection_processing
from web_demo import get_ratio, round_to_even, visualize_faces, visualize_objects, decide_target_size, camera_sweeping  

#mediapipe!!

sio = socketio.AsyncServer(async_mode='aiohttp') #app.py

ROOT = os.path.dirname(__file__)

logger = logging.getLogger("pc")
pcs = set()
relay = MediaRelay()


class VideoTransformTrack(MediaStreamTrack):
    """
    A video stream track that transforms frames from an another track.
    """

    kind = "video"

    def __init__(self, track, transform):
        super().__init__()  # don't forget this!
        self.track = track
        self.transform = transform

    async def recv(self):
        pre_x_center = -10000
        last_detection = 0
        frame = await self.track.recv()

        if self.transform == "cartoon":
            img = frame.to_ndarray(format="bgr24")

            # prepare color
            img_color = cv2.pyrDown(cv2.pyrDown(img))
            for _ in range(6):
                img_color = cv2.bilateralFilter(img_color, 9, 9, 7)
            img_color = cv2.pyrUp(cv2.pyrUp(img_color))

            # prepare edges
            img_edges = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            img_edges = cv2.adaptiveThreshold(
                cv2.medianBlur(img_edges, 7),
                255,
                cv2.ADAPTIVE_THRESH_MEAN_C,
                cv2.THRESH_BINARY,
                9,
                2,
            )
            img_edges = cv2.cvtColor(img_edges, cv2.COLOR_GRAY2RGB)

            # combine color and edges
            img = cv2.bitwise_and(img_color, img_edges)

            # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame
            '''
        elif self.transform == "edges":
            # perform edge detection
            img = frame.to_ndarray(format="bgr24")
            img = cv2.cvtColor(cv2.Canny(img, 100, 200), cv2.COLOR_GRAY2BGR)

            # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame
        elif self.transform == "rotate":
            # rotate image
            img = frame.to_ndarray(format="bgr24")
            rows, cols, _ = img.shape
            M = cv2.getRotationMatrix2D((cols / 2, rows / 2), frame.time * 45, 1)
            img = cv2.warpAffine(img, M, (cols, rows))

            # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame
            '''
        elif self.transform == "detection":
            #print("detection started!")
            image = frame.to_ndarray(format="bgr24")
            image_width = image.shape[1]
            image_height = image.shape[0]

            start_t = timeit.default_timer()

            # To improve performance, optionally mark the image as not writeable to
            # pass by reference.

            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

            image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
            # face detection
            fd = face_detection(image)
            fd.detect_faces()
            regions = fd.localization_to_region()
            visualize_faces(image, regions, image_width, image_height)

            # object detection
            od = object_detection(image)
            output_dict, category_index = od.detect_objects()
            boxes = output_dict['detection_boxes']
            classes = output_dict['detection_classes']
            scores = output_dict['detection_scores']
            visualize_objects(image, boxes, classes, scores, category_index, image_width, image_height)     
            
            # detection processing
            dp = detection_processing(boxes, classes, scores, regions[0])
            dp.tensors_to_regions()
            all_regions = dp.sort_detection()
            print(all_regions)
            ### 예비 구현

            original_ratio = get_ratio(image_width, image_height)
            requested_ratio = 9 / 16
            target_width, target_height, scaled_target = decide_target_size(original_ratio, requested_ratio, image_width, image_height)


            # detection 없을 때 고려해야 함
            # detection 여러 개일 때 프레임 흔들림 (두 개 model -> 잡을 때와 안 잡힐 때)
            # 얼굴을 detection 했을 때는 전적으로 신뢰하기로 ㄱㄱ
            x_center_list = []
            score_list = []
            optimal_x_center = 0          

            for i, region in enumerate(all_regions):
                x = region.x
                y = region.y
                w = region.w
                h = region.h
                x_center = x + w / 2
                y_center = y + h / 2
                if (i == 0): # 가로 기준(세로 고정) 나중에 수정해야 함 + 기준은 float로
                    x_center_list.append(x_center)
                    score_list.append(x_center)
                elif (scaled_target <= 0):
                    break
                elif (x_center_list[0] - x_center < scaled_target): # 바운더리 수정
                    x_center_list.append(x_center)
                    score_list.append(x_center)
                scaled_target -= x_center_list[0] - x_center
            
            if (len(x_center_list)):
                optimal_x_center = np.average(x_center_list)

            optimal_x_center = int(optimal_x_center * image_width)

            # 실시간으로 프레임 보간할 방법을 생각해야 함.... 이게 최고 난이도일듯? 지금 코드는 임시라고 보면 될듯
            if (len(all_regions) == 0): # 디텍션 없을 때
                left = int((image_width - target_width) / 2)
                pre_x_center = int(image_width / 2)
            elif (last_detection != len(all_regions)):
                left = int(optimal_x_center - target_width / 2)
                # use sweeping mode
                # 이걸 빼는게 더 자연스러움.... 당황스럽
                # await camera_sweeping(left, pre_x_center, optimal_x_center, image_width, target_width, image)
                pre_x_center = optimal_x_center
                last_detection = len(all_regions)
                # use stationary mode
            elif (abs(pre_x_center - optimal_x_center) > 30): # 가로 기준(세로 고정) -> 세로 기준 추가해야 함
                left = int(optimal_x_center - target_width / 2)
                # use sweeping mode
                # await camera_sweeping(left, pre_x_center, optimal_x_center, image_width, target_width, image)
                pre_x_center = optimal_x_center
            else:
                left = int(pre_x_center - target_width / 2)
            # print(left)
            if(left < 0):
                left = 0
            elif (left > image_width - target_width):
                left = image_width - target_width


            img = image[:, left:left+target_width]

            # fps 계산
            terminate_t = timeit.default_timer()
            fps = int(1.0 / (terminate_t - start_t))
            cv2.putText(img,
                        "FPS:" + str(fps),
                        (20, 60),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        2,
                        (0, 0, 255),
                        2)

            for i in range(len(classes)):
                    ymin, xmin, ymax, xmax = boxes[i]
                    (left, right, top, bottom) = (xmin * image_width, xmax * image_width,
                                            ymin * image_height, ymax * image_height)
                    left = int(left)
                    right = int(right)
                    top = int(top)
                    bottom = int(bottom)
                    print(left, right, top, bottom)
                    cv2.rectangle(image, (left, top), (right, bottom), (255, 0, 0), 2)
                    print(category_index[classes[i]]['name'])
                    cv2.putText(image,
                            str(category_index[classes[i]]['name']),
                            (left, top),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            3,
                            (0, 0, 255),
                            2)
                    cv2.putText(image,
                            str(scores[i]),
                            (left, top + 100),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            3,
                            (0, 0, 255),
                            2)

             # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame  

        else:
            return frame


#app.py
async def background_task():
    """Example of how to send server generated events to clients."""
    count = 0
    while True:
        await sio.sleep(10)
        count += 1
        await sio.emit('my_response', {'data': 'Server generated event'})


async def index(request):
    content = open(os.path.join(ROOT, "index.html"), "r").read()
    return web.Response(content_type="text/html", text=content)


async def javascript(request):
    content = open(os.path.join(ROOT, "client.js"), "r").read()
    return web.Response(content_type="application/javascript", text=content)

async def javascript2(request):
    content = open(os.path.join(ROOT, "timer.js"), "r").read()
    return web.Response(content_type="application/javascript", text=content)

@sio.event
async def my_event(sid, message):
    await sio.emit('my_response', {'data': message['data']}, room=sid)


@sio.event
async def my_broadcast_event(sid, message):
    await sio.emit('my_response', {'data': message['data']})


@sio.event
async def join(sid, message):
    sio.enter_room(sid, message['room'])
    await sio.emit('my_response', {'data': 'Entered room: ' + message['room']},
                   room=sid)


@sio.event
async def leave(sid, message):
    sio.leave_room(sid, message['room'])
    await sio.emit('my_response', {'data': 'Left room: ' + message['room']},
                   room=sid)


@sio.event
async def close_room(sid, message):
    await sio.emit('my_response',
                   {'data': 'Room ' + message['room'] + ' is closing.'},
                   room=message['room'])
    await sio.close_room(message['room'])


@sio.event
async def my_room_event(sid, message):
    await sio.emit('my_response', {'data': message['data']},
                   room=message['room'])


@sio.event
async def disconnect_request(sid):
    await sio.disconnect(sid)


@sio.event
async def connect(sid, environ):
    await sio.emit('my_response', {'data': 'Connected', 'count': 0}, room=sid)


@sio.event
def disconnect(sid):
    print('Client disconnected')

#app.py
async def init_app():
    sio.start_background_task(background_task)
    return app


async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pc_id = "PeerConnection(%s)" % uuid.uuid4()
    pcs.add(pc)

    def log_info(msg, *args):
        logger.info(pc_id + " " + msg, *args)

    log_info("Created for %s", request.remote)

    # prepare local media
    player = MediaPlayer(os.path.join(ROOT, "demo-instruct.wav"))
    if args.record_to:
        recorder = MediaRecorder(args.record_to)
    else:
        recorder = MediaBlackhole()

    @pc.on("datachannel")
    def on_datachannel(channel):
        @channel.on("message")
        def on_message(message):
            if isinstance(message, str) and message.startswith("ping"):
                channel.send("pong" + message[4:])

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        log_info("Connection state is %s", pc.connectionState)
        if pc.connectionState == "failed":
            await pc.close()
            pcs.discard(pc)

    @pc.on("track")
    def on_track(track):
        log_info("Track %s received", track.kind)

        if track.kind == "audio":
            pc.addTrack(player.audio)
            recorder.addTrack(track)
        elif track.kind == "video":
            pc.addTrack(
                VideoTransformTrack(
                    relay.subscribe(track), transform=params["video_transform"]
                )
            )
            if args.record_to:
                recorder.addTrack(relay.subscribe(track))

        @track.on("ended")
        async def on_ended():
            log_info("Track %s ended", track.kind)
            await recorder.stop()

    # handle offer
    await pc.setRemoteDescription(offer)
    await recorder.start()

    # send answer
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
        ),
    )


async def on_shutdown(app):
    # close peer connections
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="WebRTC audio / video / data-channels demo"
    )
    parser.add_argument("--cert-file", help="SSL certificate file (for HTTPS)")
    parser.add_argument("--key-file", help="SSL key file (for HTTPS)")
    parser.add_argument(
        "--host", default="0.0.0.0", help="Host for HTTP server (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port", type=int, default=8080, help="Port for HTTP server (default: 8080)"
    )
    parser.add_argument("--record-to", help="Write received media to a file."),
    parser.add_argument("--verbose", "-v", action="count")
    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)

    if args.cert_file:
        ssl_context = ssl.SSLContext()
        ssl_context.load_cert_chain(args.cert_file, args.key_file)
    else:
        ssl_context = None
    
    app = web.Application()
    sio.attach(app) #app.py
    app.on_shutdown.append(on_shutdown)
    app.router.add_static('/static', 'static') #app.py
    app.router.add_get("/", index)
    app.router.add_get("/client.js", javascript)
    app.router.add_get("/timer.js", javascript2)    
    app.router.add_post("/offer", offer)
    
    
    web.run_app(
        init_app(), access_log=None, host=args.host, port=args.port, ssl_context=ssl_context
    )