# Voice activity detection in Typescript

vad.ts is a small Javascript library for voice activity detection.

Modified from [kdavis-mozilla/vad.js](https://github.com/kdavis-mozilla/vad.js)

```typescript
import VAD from './vad.ts';

// Create AudioContext
window.AudioContext = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioContext();

// Define function called by getUserMedia 
function startUserMedia(stream) {
    // Create MediaStreamAudioSourceNode
    const source = audioContext.createMediaStreamSource(stream);

    // Setup options
    const options = {
        source: source,
        voice_stop: function() {console.log('voice_stop');}, 
        voice_start: function() {console.log('voice_start');}
    }; 
    
    // Create VAD
    const vad = new VAD({
        source: source,
        voice_stop_delay: 1000, // When stopping speech, if this time is exceeded before calling voice_stop
        voice_stop: () => {
            console.log('voice_stop');
        },
        voice_start: () => {
            console.log('voice_start');
        },
        voiceTimeout: 5000, // When no sound is detected for a long time
        voiceTimeoutCallback: () => {
            console.log('voiceTimeoutCallback');
        },
    });
}

// Ask for audio device
navigator.getUserMedia = navigator.getUserMedia || 
                         navigator.mozGetUserMedia || 
                         navigator.webkitGetUserMedia;
navigator.getUserMedia({audio: true}, startUserMedia, function(e) {
    console.log("No live audio input in this browser: " + e);
});
```
