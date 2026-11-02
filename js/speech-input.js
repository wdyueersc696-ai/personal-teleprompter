// All resources are local to this origin. Changing or stopping recognition
// disconnects this Web Audio branch, never the microphone owned by the recorder.
const processorUrl = new URL('./speech-processor.js', import.meta.url).href;
const modelUrl = new URL('../vendor/vosk-model-small-ru-0.22.tar.gz', import.meta.url).href;
const localModelError = 'Не удалось открыть русскую модель. При первом включении нужны интернет и свободная память.';
const unsupportedError = 'В этом браузере недоступно локальное распознавание речи.';

async function loadLibrary() {
  await import('../vendor/vosk-0.0.8.js');
  return globalThis.Vosk;
}

function createContext() {
  if (!globalThis.AudioContext || !globalThis.AudioWorkletNode || !globalThis.WebAssembly) {
    throw new Error(unsupportedError);
  }
  return new AudioContext();
}

function createProcessor(context) {
  return new AudioWorkletNode(context, 'teleprompter-speech', {
    channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
  });
}

export function createSpeechInput({
  onResult, onStatus = () => {}, onError = () => {},
  openContext = createContext, openProcessor = createProcessor, loadVosk = loadLibrary,
}) {
  let current = null;
  let segment = 0;

  // Call within the button gesture, before waiting on getUserMedia permissions.
  function prepare() {
    if (current) return;
    const context = openContext();
    const resumed = context.resume();
    resumed.catch(() => {}); // May reject before start() obtains the shared stream.
    current = { context, resumed, cancel: new AbortController(), starting: false, epoch: 0 };
  }

  function stop() {
    const session = current;
    if (!session) return;
    current = null;
    session.cancel.abort();
    session.context.onstatechange = null;
    session.track?.removeEventListener('ended', session.lostTrack);
    session.source?.disconnect();
    if (session.processor) {
      session.processor.port.onmessage = null;
      session.processor.port.close();
      session.processor.disconnect();
    }
    // Pinned vosk-browser 0.0.8's model.terminate() sends an async command
    // that assumes a fully initialized model. Cancel the owning dedicated
    // worker itself, also during a pending download or model initialization.
    session.model?.worker.terminate();
    void session.context.close().catch(() => {});
    onStatus('off');
  }

  function fail(session, message) {
    if (session !== current) return;
    const error = new Error(message);
    if (session.starting) {
      session.rejectStart(error);
    } else {
      stop();
      onError(error);
    }
  }

  function resetSegment() {
    const session = current;
    if (!session?.model?.ready || !session.processor) return;
    const old = session.recognizer;
    const recognizer = new session.model.KaldiRecognizer(session.context.sampleRate);
    session.recognizer = recognizer;
    old?.remove();
    segment++;
    session.epoch++;
    session.pending = 0;
    session.processor.port.postMessage({ epoch: session.epoch });

    const deliver = (text, final) => {
      if (session !== current || recognizer !== session.recognizer) return;
      session.pending = Math.max(0, session.pending - 1);
      if (text?.trim()) onResult({ text: text.trim(), final, segment });
      if (final) segment++;
    };
    recognizer.on('partialresult', ({ result }) => deliver(result.partial, false));
    recognizer.on('result', ({ result }) => deliver(result.text, true));
    recognizer.on('error', () => {
      if (recognizer === session.recognizer) fail(session, 'Ошибка распознавания речи.');
    });
  }

  async function start(stream) {
    if (current?.starting || current?.recognizer) stop();
    prepare();
    const session = current;
    const { context, cancel } = session;
    const track = stream?.getAudioTracks().find((item) => item.readyState === 'live');
    if (!track) {
      stop();
      throw new Error('Нет активной дорожки микрофона.');
    }
    session.starting = true;
    const interrupted = new Promise((_, reject) => {
      session.rejectStart = reject;
      cancel.signal.addEventListener('abort', () => reject(new DOMException('Отменено', 'AbortError')), { once: true });
    });
    session.track = track;
    session.lostTrack = () => fail(session, 'Микрофон отключён.');
    track.addEventListener('ended', session.lostTrack);
    const deadline = setTimeout(() => fail(session, localModelError), 180_000);
    try {
      onStatus('loading');
      const [vosk] = await Promise.race([interrupted, Promise.all([
        loadVosk(), context.audioWorklet.addModule(processorUrl), session.resumed,
      ])]);
      if (session !== current) return;
      const model = new vosk.Model(modelUrl, -2);
      session.model = model;
      model.on('error', () => fail(session, localModelError));
      model.worker.addEventListener('error', () => fail(session, localModelError));
      model.worker.addEventListener('messageerror', () => fail(session, localModelError));
      await Promise.race([interrupted, new Promise((resolve, reject) => {
        model.on('load', ({ result }) => result ? resolve() : reject(new Error(localModelError)));
      })]);
      if (session !== current) return;
      session.processor = openProcessor(context);
      session.source = context.createMediaStreamSource(stream);
      resetSegment();
      session.processor.onprocessorerror = () => fail(session, 'Ошибка обработки звука.');
      session.processor.port.onmessage = ({ data }) => {
        if (session !== current || data.epoch !== session.epoch) return;
        // One reply per chunk. If inference cannot keep pace, don't build an
        // unbounded backlog and move the script to words read long ago.
        if (++session.pending * 4096 > context.sampleRate * 4) {
          fail(session, 'Устройство не успевает распознавать речь.');
          return;
        }
        try {
          session.recognizer.acceptWaveformFloat(data.pcm, context.sampleRate);
        } catch {
          fail(session, 'Ошибка обработки звука.');
        }
      };
      session.source.connect(session.processor);
      session.processor.connect(context.destination);
      session.starting = false;
      context.onstatechange = () => {
        if (context.state !== 'running') fail(session, 'Браузер приостановил обработку звука.');
      };
      onStatus('listening');
    } catch (error) {
      if (current === session) stop();
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  return { prepare, start, stop, resetSegment };
}
