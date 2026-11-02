// The output stays silent; only the first (downmixed) input goes to ASR.
class SpeechProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.epoch = 0;
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.port.onmessage = ({ data }) => {
      this.epoch = data.epoch;
      this.used = 0;
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(this.buffer.length - this.used, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
      if (this.used === this.buffer.length) {
        this.port.postMessage({ pcm: this.buffer, epoch: this.epoch }, [this.buffer.buffer]);
        this.buffer = new Float32Array(4096);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('teleprompter-speech', SpeechProcessor);
