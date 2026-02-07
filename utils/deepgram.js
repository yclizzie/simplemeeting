// utils/deepgram.js

export default class DeepgramService {
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
        diarize: 'true',
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

      const words = alternatives[0].words || [];
      if (!words.length) return alternatives[0].transcript ?? '';

      // Build speaker-attributed transcript from word-level speaker IDs
      this.speakerMap = {};
      let lines = [];
      let currentSpeaker = null;
      let currentWords = [];

      for (const w of words) {
        const speaker = w.speaker ?? 0;
        if (speaker !== currentSpeaker) {
          if (currentWords.length) {
            const label = this.getSpeakerLabel(currentSpeaker);
            lines.push(`${label}: ${currentWords.join(' ')}`);
          }
          currentSpeaker = speaker;
          currentWords = [];
        }
        currentWords.push(w.punctuated_word || w.word);
      }
      if (currentWords.length) {
        const label = this.getSpeakerLabel(currentSpeaker);
        lines.push(`${label}: ${currentWords.join(' ')}`);
      }

      return lines.join('\n');
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