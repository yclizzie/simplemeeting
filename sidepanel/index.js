// Side panel JavaScript
let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let startTime = null;
let timerInterval = null;

// UI Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const playBtn = document.getElementById('playBtn');
const statusText = document.getElementById('statusText');
const statusDiv = document.querySelector('.status');
const recordingTime = document.getElementById('recordingTime');

// Event Listeners
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
playBtn.addEventListener('click', playRecording);

async function startRecording() {
  try {
    // Get the current tab
    //const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Request tab audio stream
    // const tabStream = await new Promise((resolve, reject) => {
    //   chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
    //     if (chrome.runtime.lastError) {
    //       reject(new Error(chrome.runtime.lastError.message));
    //     } else {
    //       resolve(stream);
    //     }
    //   });
    // });

    const tabStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });

    // Request microphone stream
    // Request microphone stream first
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      console.log('Microphone access granted');
    } catch (micError) {
      console.error('Microphone error:', micError);
      throw new Error('Microphone access denied. Please allow microphone access in your browser settings.');
    }

   // Create audio context to mix both streams
    const audioContext = new AudioContext();
    
    // Create sources from both streams
    const tabSource = audioContext.createMediaStreamSource(tabStream);
    const micSource = audioContext.createMediaStreamSource(micStream);
    
    // Create destination to merge streams
    const destination = audioContext.createMediaStreamDestination();
    
    // Connect both sources to destination
    tabSource.connect(destination);
    micSource.connect(destination);

    // Create MediaRecorder with the mixed stream
    mediaRecorder = new MediaRecorder(destination.stream, {
      mimeType: 'audio/webm'
    });

    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(audioChunks, { type: 'audio/webm' });
      playBtn.disabled = false;
      
      // Stop all tracks
      tabStream.getTracks().forEach(track => track.stop());
      micStream.getTracks().forEach(track => track.stop());
      
      // Close audio context
      audioContext.close();
    };

    mediaRecorder.start();
    
    // Update UI
    startBtn.disabled = true;
    stopBtn.disabled = false;
    playBtn.disabled = true;
    statusText.textContent = 'Recording...';
    statusDiv.classList.add('recording');
    
    // Start timer
    startTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    
  } catch (error) {
    console.error('Error starting recording:', error);
    statusText.textContent = `Error: ${error.message}`;
    alert(`Failed to start recording: ${error.message}`);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    
    // Update UI
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.textContent = 'Recording stopped';
    statusDiv.classList.remove('recording');
    
    // Stop timer
    clearInterval(timerInterval);
  }
}

function playRecording() {
  if (recordedBlob) {
    const audioUrl = URL.createObjectURL(recordedBlob);
    const audio = new Audio(audioUrl);
    
    audio.onended = () => {
      statusText.textContent = 'Playback finished';
      URL.revokeObjectURL(audioUrl);
    };
    
    audio.onerror = (error) => {
      console.error('Error playing audio:', error);
      statusText.textContent = 'Error playing audio';
    };
    
    statusText.textContent = 'Playing...';
    audio.play();
  }
}

function updateTimer() {
  if (startTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    recordingTime.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
}

// Initialize
recordingTime.textContent = '00:00';