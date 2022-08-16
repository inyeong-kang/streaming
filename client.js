    // 엘리먼트 취득
const $video = document.querySelector("#video");
const btn_start = document.querySelector("#record_start");
const btn_stop = document.querySelector("#record_stop");
const muteBtn = document.getElementById("mute");
const cameraBtn = document.getElementById("camera");

// MediaRecorder(녹화기) 변수 선언
let mediaRecorder = null;
// 스트림 데이터를 담아둘 배열 생성
const arrVideoData = [];
let myStream;
let muted = false;
let cameraOff = false;

call.hidden = true;

// get DOM elements
var dataChannelLog = document.getElementById('data-channel'),
    iceConnectionLog = document.getElementById('ice-connection-state'),
    iceGatheringLog = document.getElementById('ice-gathering-state'),
    signalingLog = document.getElementById('signaling-state');

// peer connection
let pc = null;

// data channel
var dc = null, dcInterval = null;


  async function getMedia(deviceId) {
    const initialConstrains = {
      audio: true,
      video: { facingMode: "user" },
    };
    const cameraConstraints = {
      audio: true,
      video: { deviceId: { exact: deviceId } },
    };
    try {
      myStream = await navigator.mediaDevices.getUserMedia(
        deviceId ? cameraConstraints : initialConstrains
      );
      $video.srcObject = myStream;
    } catch (e) {
      console.log(e);
    }
}
  
function handleMuteClick() {
    myStream
      .getAudioTracks()
      .forEach((track) => (track.enabled = !track.enabled));
    if (!muted) {
      muteBtn.innerText = "Unmute";
      muted = true;
    } else {
      muteBtn.innerText = "Mute";
      muted = false;
    }
  }

  function handleCameraClick() {
    myStream
      .getVideoTracks()
      .forEach((track) => (track.enabled = !track.enabled));
    if (cameraOff) {
      cameraBtn.innerText = "Turn Camera Off";
      cameraOff = false;
    } else {
      cameraBtn.innerText = "Turn Camera On";
      cameraOff = true;
    }
}
  
//make connection
function createPeerConnection() {
    var config = {
        sdpSemantics: 'unified-plan'
    };

    if (document.getElementById('use-stun').checked) {
        config.iceServers = [{
            urls: [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302",
                "stun:stun3.l.google.com:19302",
                "stun:stun4.l.google.com:19302",
            ],        
        }];
    }

    pc = new RTCPeerConnection(config);

    // register some listeners to help debugging
    pc.addEventListener('icegatheringstatechange', function() {
        iceGatheringLog.textContent += ' -> ' + pc.iceGatheringState;
    }, false);
    iceGatheringLog.textContent = pc.iceGatheringState;

    pc.addEventListener('iceconnectionstatechange', function() {
        iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState;
    }, false);
    iceConnectionLog.textContent = pc.iceConnectionState;

    pc.addEventListener('signalingstatechange', function() {
        signalingLog.textContent += ' -> ' + pc.signalingState;
    }, false);
    signalingLog.textContent = pc.signalingState;

    // connect audio / video
    pc.addEventListener('track', function(evt) {
        if (evt.track.kind == 'video') 
            document.getElementById('video').srcObject = evt.streams[0];
        else
            document.getElementById('audio').srcObject = evt.streams[0];
    });

    return pc;
}

function negotiate() {
    return pc.createOffer().then(function(offer) {
        return pc.setLocalDescription(offer);
    }).then(function() {
        // wait for ICE gathering to complete
        return new Promise(function(resolve) {
            if (pc.iceGatheringState === 'complete') {
                resolve();
            } else {
                function checkState() {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                }
                pc.addEventListener('icegatheringstatechange', checkState);
            }
        });
    }).then(function() {
        var offer = pc.localDescription;
        var codec;

        codec = document.getElementById('audio-codec').value;
        if (codec !== 'default') {
            offer.sdp = sdpFilterCodec('audio', codec, offer.sdp);
        }

        codec = document.getElementById('video-codec').value;
        if (codec !== 'default') {
            offer.sdp = sdpFilterCodec('video', codec, offer.sdp);
        }

        document.getElementById('offer-sdp').textContent = offer.sdp;
        return fetch('/offer', {
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type,
                video_transform: document.getElementById('video-transform').value
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    }).then(function(response) {
        return response.json();
    }).then(function(answer) {
        document.getElementById('answer-sdp').textContent = answer.sdp;
        return pc.setRemoteDescription(answer);
    }).catch(function(e) {
        alert(e);
    });
}

muteBtn.addEventListener("click", handleMuteClick);
cameraBtn.addEventListener("click", handleCameraClick);

const welcome = document.getElementById("welcome");
const welcomeForm = welcome.querySelector("form");
const head = document.getElementById("head");
let roomName;

async function initCall(){
    welcome.hidden = true;
    call.hidden = false;
    const roomTitle = document.getElementById("roomTitle");
    roomTitle.style.color = "blue";
    const input = welcomeForm.querySelector("input"); 
    roomName = input.value;
    roomTitle.innerText = `👋 Welcome to ${roomName} Room`;

}

function start() {
    //document.getElementById('start').style.display = 'none';
    getMedia();

    pc = createPeerConnection(); //make connection

    var time_start = null;

    function current_stamp() {
        if (time_start === null) {
            time_start = new Date().getTime();
            return 0;
        } else {
            return new Date().getTime() - time_start;
        }
    }

    if (document.getElementById('use-datachannel').checked) {
        var parameters = JSON.parse(document.getElementById('datachannel-parameters').value);

        dc = pc.createDataChannel('chat', parameters);
        dc.onclose = function() {
            clearInterval(dcInterval);
            dataChannelLog.textContent += '- close\n';
        };
        dc.onopen = function() {
            dataChannelLog.textContent += '- open\n';
            dcInterval = setInterval(function() {
                var message = 'ping ' + current_stamp();
                dataChannelLog.textContent += '> ' + message + '\n';
                dc.send(message);
            }, 1000);
        };
        dc.onmessage = function(evt) {
            dataChannelLog.textContent += '< ' + evt.data + '\n';

            if (evt.data.substring(0, 4) === 'pong') {
                var elapsed_ms = current_stamp() - parseInt(evt.data.substring(5), 10);
                dataChannelLog.textContent += ' RTT ' + elapsed_ms + ' ms\n';
            }
        };
    }

    var constraints = {
        audio: document.getElementById('use-audio').checked,
        video: false
    };

    if (document.getElementById('use-video').checked) {
        var resolution = document.getElementById('video-resolution').value;
        if (resolution) {
            resolution = resolution.split('x');
            constraints.video = {
                width: parseInt(resolution[0], 0),
                height: parseInt(resolution[1], 0)
            };
        } else {
            constraints.video = true;
        }
    }

    if (constraints.audio || constraints.video) {
        if (constraints.video) {
            document.getElementById('media').style.display = 'block';
        }

        //pc.addEventListener("icecandidate", handleIce);        
        pc.addEventListener("addstream", handleAddStream);

        navigator.mediaDevices.getUserMedia(constraints).then(function() {
            myStream.getTracks().forEach(function(track) {
                pc.addTrack(track, myStream);
            });
            return negotiate();
        }, function(err) {
            alert('Could not acquire media: ' + err);
        });
    } else {
        negotiate();
    }

    //document.getElementById('stop').style.display = 'inline-block';
}
/*
function handleIce(data) {
    console.log("sent candidate");
    socket.emit("ice", data.candidate, roomName);
}
  */
function handleAddStream(data) {
    const peerFace = document.getElementById("peer-video");
    peerFace.srcObject = data.stream;
}

function stop() {
    //document.getElementById('stop').style.display = 'none';

    // close data channel
    if (dc) {
        dc.close();
    }

    // close transceivers
    if (pc.getTransceivers) {
        pc.getTransceivers().forEach(function(transceiver) {
            if (transceiver.stop) {
                transceiver.stop();
            }
        });
    }

    // close local audio / video
    pc.getSenders().forEach(function(sender) {
        sender.track.stop();
    });

    // close peer connection
    setTimeout(function() {
        pc.close();
    }, 500);

    location.reload(true);
}

function sdpFilterCodec(kind, codec, realSdp) {
    var allowed = []
    var rtxRegex = new RegExp('a=fmtp:(\\d+) apt=(\\d+)\r$');
    var codecRegex = new RegExp('a=rtpmap:([0-9]+) ' + escapeRegExp(codec))
    var videoRegex = new RegExp('(m=' + kind + ' .*?)( ([0-9]+))*\\s*$')
    
    var lines = realSdp.split('\n');

    var isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var match = lines[i].match(codecRegex);
            if (match) {
                allowed.push(parseInt(match[1]));
            }

            match = lines[i].match(rtxRegex);
            if (match && allowed.includes(parseInt(match[2]))) {
                allowed.push(parseInt(match[1]));
            }
        }
    }

    var skipRegex = 'a=(fmtp|rtcp-fb|rtpmap):([0-9]+)';
    var sdp = '';

    isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var skipMatch = lines[i].match(skipRegex);
            if (skipMatch && !allowed.includes(parseInt(skipMatch[2]))) {
                continue;
            } else if (lines[i].match(videoRegex)) {
                sdp += lines[i].replace(videoRegex, '$1 ' + allowed.join(' ')) + '\n';
            } else {
                sdp += lines[i] + '\n';
            }
        } else {
            sdp += lines[i] + '\n';
        }
    }

    return sdp;
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// "녹화시작" 버튼 이벤트 처리
function recordStart(event){

    const mediaStream = video.captureStream();
    // MediaRecorder(녹화기) 객체 생성
    mediaRecorder = new MediaRecorder(mediaStream);
    // MediaRecorder.dataavailable 이벤트 처리
    mediaRecorder.ondataavailable = (event)=>{
        // 스트림 데이터(Blob)가 들어올 때마다 배열에 담아둔다.
        arrVideoData.push(event.data);
    }

    // MediaRecorder.stop 이벤트 처리
    mediaRecorder.onstop = (event)=>{
        // 들어온 스트림 데이터들(Blob)을 통합한 Blob객체를 생성
        const blob = new Blob(arrVideoData);

        // BlobURL 생성: 통합한 스트림 데이터를 가르키는 임시 주소를 생성
        const blobURL = window.URL.createObjectURL(blob);

        // 다운로드 구현
        const $anchor = document.createElement("a"); // 앵커 태그 생성
        document.body.appendChild($anchor);
        $anchor.style.display = "none";
        $anchor.href = blobURL; // 다운로드 경로 설정
        $anchor.download = "test.webm"; // 파일명 설정
        $anchor.click(); // 앵커 클릭

        // 배열 초기화
        arrVideoData.splice(0);
    }

    // 녹화 시작
    mediaRecorder.start(); 
}

function recordStop(event){
   // 녹화 중단!
   mediaRecorder.stop(); 
}

//socket.io
$(document).ready(function(){
    var socket = io.connect();

    socket.on('connect', function() {
        socket.emit('my_event', {data: 'I\'m connected!'});
    });
    socket.on('disconnect', function() {
        $('#log').append('<br>Disconnected');
    });
    socket.on('my_response', function(msg) {
        $('#log').append('<br>Received: ' + msg.data);
    });
    
    socket.on("ice", (ice, roomName) => {
        socket.to(roomName).emit("ice", ice);
    });
    // event handler for server sent data
    // the data is displayed in the "Received" section of the page
    // handlers for the different forms in the page
    // these send data to the server in a variety of ways
    $('form#emit').submit(function(event) {
        socket.emit('my_event', {data: $('#emit_data').val()});
        return false;
    });
    $('form#broadcast').submit(function(event) {
        socket.emit('my_broadcast_event', {data: $('#broadcast_data').val()});
        return false;
    });
    $('form#join').submit(function(event) {
        socket.emit('join', {room: $('#join_room').val()});
        roomName = $('#join_room').val();
        return false;
    });
    $('form#leave').submit(function(event) {
        socket.emit('leave', {room: roomName});
        console.log(roomName);
        return false;
    });
    $('form#send_room').submit(function(event) {
        socket.emit('my_room_event', {room: $('#room_name').val(), data: $('#room_data').val()});
        return false;
    });
    $('form#close').submit(function(event) {
        socket.emit('close_room', {room: $('#close_room').val()});
        return false;
    });
    $('form#disconnect').submit(function(event) {
        socket.emit('disconnect_request');
        return false;
    });
});
