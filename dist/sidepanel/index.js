(function () {
  'use strict';

  // utils/deepgram.js

  class DeepgramService {
      constructor(apiKey) {
        this.apiKey = apiKey;
        this.socket = null;
        this.listeners = {};
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.speakerMap = {};
      }
      
      /**
       * Connect to Deepgram WebSocket
       */
      async connect() {
        const url = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
          model: 'nova-2',                    // Latest model
          language: 'en',
          punctuate: 'true',                  // Add punctuation
          diarize: 'true',                    // Enable speaker diarization
          diarize_version: '2023-09-19',      // Latest diarization model
          smart_format: 'true',               // Smart formatting
          interim_results: 'false',           // Only final results
          encoding: 'linear16',               // Audio encoding
          sample_rate: '48000'                // Match capture sample rate
        });
        
        return new Promise((resolve, reject) => {
          this.socket = new WebSocket(url, ['token', this.apiKey]);
          
          this.socket.onopen = () => {
            console.log('✓ Deepgram WebSocket connected');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            resolve();
          };
          
          this.socket.onmessage = (event) => {
            this.handleMessage(event.data);
          };
          
          this.socket.onerror = (error) => {
            console.error('Deepgram WebSocket error:', error);
            this.emit('error', error);
            reject(error);
          };
          
          this.socket.onclose = (event) => {
            console.log('Deepgram WebSocket closed:', event.code, event.reason);
            this.isConnected = false;
            
            // Attempt reconnection if unexpected close
            if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
              this.attemptReconnect();
            }
          };
        });
      }
      
      /**
       * Handle incoming WebSocket message
       */
      handleMessage(data) {
        console.log('Deepgram message received:' + data);
        try {
          const parsed = JSON.parse(data);
          
          // Handle Metadata type messages
          if (parsed.type === 'Metadata') {
            console.log('Deepgram metadata:', {
              request_id: parsed.request_id,
              created: parsed.created,
              duration: parsed.duration,
              channels: parsed.channels
            });
            // Metadata messages don't contain transcripts, so return early
            return;
          }

          // Check for transcript
          if (parsed.channel?.alternatives?.[0]) {
            const alternative = parsed.channel.alternatives[0];
            
            if (alternative.transcript && parsed.is_final) {
              // Extract speaker information
              const words = alternative.words || [];
              const speakerId = words[0]?.speaker ?? 0;
              
              const speakerLabel = this.getSpeakerLabel(speakerId);
              
              // Emit transcript event
              this.emit('transcript', {
                text: alternative.transcript,
                speaker: speakerLabel,
                speakerId: speakerId,
                confidence: alternative.confidence,
                timestamp: Date.now(),
                is_final: true
              });
            }
          }
          
          // Handle metadata
          if (parsed.metadata) {
            console.log('Deepgram metadata:', parsed.metadata);
          }
          
        } catch (error) {
          console.error('Error parsing Deepgram message:', error);
        }
      }
      
      /**
       * Get human-readable speaker label
       */
      getSpeakerLabel(speakerId) {
        if (!this.speakerMap[speakerId]) {
          const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
          const index = Object.keys(this.speakerMap).length;
          this.speakerMap[speakerId] = `Speaker ${labels[index] || index}`;
        }
        return this.speakerMap[speakerId];
      }
      
      /**
       * Send audio data to Deepgram
       */
      sendAudio(audioBuffer) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          console.log('Sending audio to Deepgram:' + audioBuffer.length);
          this.socket.send(audioBuffer);
        } else {
          console.warn('Cannot send audio: WebSocket not connected');
        }
      }
      
      /**
       * Attempt to reconnect
       */
      async attemptReconnect() {
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        setTimeout(async () => {
          try {
            await this.connect();
          } catch (error) {
            console.error('Reconnection failed:', error);
          }
        }, 2000 * this.reconnectAttempts); // Exponential backoff
      }
      
      /**
       * Transcribe a pre-recorded audio blob (e.g. after recording stops).
       * Uses Deepgram REST API. Returns full transcript text or throws.
       */
      async transcribeRecording(audioBlob) {
        const params = new URLSearchParams({
          model: 'nova-2',
          language: 'en',
          punctuate: 'true',
          smart_format: 'true',
        });
        const url = `https://api.deepgram.com/v1/listen?${params}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': audioBlob.type || 'audio/webm',
          },
          body: audioBlob,
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Deepgram: ${res.status} ${err}`);
        }
        const data = await res.json();
        const channel = data.results?.channels?.[0];
        const alternatives = channel?.alternatives;
        if (!alternatives?.length) return '';
        return alternatives[0].transcript ?? '';
      }

      /**
       * Close connection
       */
      close() {
        if (this.socket) {
          this.socket.close(1000, 'Session ended');
          this.socket = null;
        }
        this.isConnected = false;
        this.speakerMap = {};
      }
      
      /**
       * Event emitter methods
       */
      on(event, callback) {
        if (!this.listeners[event]) {
          this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
      }
      
      emit(event, data) {
        if (this.listeners[event]) {
          this.listeners[event].forEach(callback => callback(data));
        }
      }
    }

  // Side panel JavaScript

  let mediaRecorder = null;
  let audioChunks = [];
  let recordedBlob = null;
  let startTime = null;
  let timerInterval = null;
  let micStream = null;

  // UI Elements
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const playBtn = document.getElementById('playBtn');
  const statusText = document.getElementById('statusText');
  const statusDiv = document.querySelector('.status');
  const recordingTime = document.getElementById('recordingTime');
  const transcriptEl = document.getElementById('transcript');

  // Event Listeners
  startBtn.addEventListener('click', startRecording);
  stopBtn.addEventListener('click', stopRecording);
  playBtn.addEventListener('click', playRecording);


  async function startRecording() {
    // New session: clear transcript
    transcriptEl.textContent = '';
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

      mediaRecorder.onstop = async () => {
        recordedBlob = new Blob(audioChunks, { type: 'audio/webm' });
        playBtn.disabled = false;
        
        // Stop all tracks
        tabStream.getTracks().forEach(track => track.stop());
        micStream.getTracks().forEach(track => track.stop());
        
        // Close audio context
        audioContext.close();

        // Send to Deepgram and show transcript
        statusText.textContent = 'Transcribing...';
        try {
          const deepgram = new DeepgramService("dd12a356303aa4b6012ba8769cbc0bd85eb90af5");
          const text = await deepgram.transcribeRecording(recordedBlob);
          transcriptEl.textContent = text || '(No speech detected)';
          statusText.textContent = 'Recording stopped';
        } catch (err) {
          console.error('Transcription error:', err);
          transcriptEl.textContent = `Error: ${err.message}`;
          statusText.textContent = 'Transcription failed';
        }
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

})();
