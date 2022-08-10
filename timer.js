let hour = 0;
let minute = 0;
let second = 0;
let active = false;

const startBtn = document.getElementById("start");
function timerOn() {
    if (active == false) {
    active = true;
    timeoutId = setInterval(function () {
        second++;
        if (second > 59) {
        second = 0;
        minute++;
        if (minute > 59) {
            minute = 0;
            hour++;
            if (hour > 59) {
            hour = 0;
            }
        }
        }
        document.getElementById("time").innerText =
        (hour < 10 ? "0" + hour : hour) +
        ":" +
        (minute < 10 ? "0" + minute : minute) +
        ":" +
        (second < 10 ? "0" + second : second);
    }, 1000);
    }
};

function timerOff() {
    clearInterval(timeoutId);
    active = false;
};
