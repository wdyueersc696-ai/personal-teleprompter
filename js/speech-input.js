// All resources are local to this origin. Changing or stopping recognition
// disconnects this Web Audio branch, never the microphone owned by the recorder.
const processorUrl = new URL('./speech-processor.js', import.meta.url).href;
const modelUrl = new URL('../vendor/vosk-model-small-ru-0.22.tar.gz', import.meta.url).href;
const localModelError = 'Не удалось открыть русскую модель. При первом включении нужны интернет и свободная память.';
const unsupportedError = 'В этом браузере недоступно локальное распознавание речи.';
const micError = 'Нет звука от микрофона. Проверьте доступ к нему и нажмите кнопку голоса ещё раз.';
let libraryFailures = 0;

async function loadLibrary() {
  const url = new URL('../vendor/vosk-0.0.8-mobile.js', import.meta.url);
  // A failed module fetch may stay in this document's module map. A fresh
  // request allows retrying after restoring the connection without a reload.
  if (libraryFailures) url.searchParams.set('retry', libraryFailures);
  try { await import(url.href); }
  catch (error) { libraryFailures++; throw error; }
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
  let retained = null;
  let releaseTimer;

  function releaseRetained() {
    clearTimeout(releaseTimer);
    retained?.worker.terminate();
    retained = null;
  }

  // Call within the button gesture, before waiting on getUserMedia permissions.
  function prepare() {
    if (current) return;
    const context = openContext();
    const resumed = context.resume();
    resumed.catch(() => {}); // May reject before start() obtains the shared stream.
    current = { context, resumed, cancel: new AbortController(), starting: false, epoch: 0 };
  }

  function stop({ keepModel = false } = {}) {
    const session = current;
    if (!keepModel) releaseRetained();
    if (!session) return;
    current = null;
    session.cancel.abort();
    clearTimeout(session.deadline);
    session.context.onstatechange = null;
    session.track?.removeEventListener('ended', session.lostTrack);
    session.source?.disconnect();
    if (session.processor) {
      session.processor.port.onmessage = null;
      session.processor.port.close();
      session.processor.disconnect();
    }
    // Upstream model.terminate() assumes initialization has finished.
    // A pending worker can be terminated directly when loading is cancelled.
    if (keepModel && session.model?.ready && session.recognizer) {
      session.recognizer.remove();
      releaseRetained();
      retained = session.model;
      releaseTimer = setTimeout(releaseRetained, 30_000);
    } else {
      session.model?.worker.terminate();
    }
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

  function watch(session, duration, message) {
    clearTimeout(session.deadline);
    session.deadline = setTimeout(() => fail(session, message), duration);
  }

  function bindModel(model) {
    // Resolve the current owner for each event: a warmed model can be reused
    // with a new AudioContext without keeping listeners for old sessions.
    const modelFailed = ({ error } = {}) => {
      if (retained === model) releaseRetained();
      if (current?.model !== model) return;
      const message = /^Не удалось (загрузить|открыть) русскую модель\./.test(error) ? error : localModelError;
      fail(current, message);
    };
    model.on('error', modelFailed);
    model.worker.addEventListener('error', modelFailed);
    model.worker.addEventListener('messageerror', modelFailed);
    model.on('progress', ({ state, detail }) => {
      if (current?.model !== model || !current.starting) return;
      watch(current, 60_000, state === 'downloading' ? 'Загрузка модели остановилась. Проверьте интернет и включите голос ещё раз.' : localModelError);
      onStatus(state, detail);
    });
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
    try {
      onStatus('loading');
      // iOS may interrupt the context when getUserMedia switches the audio
      // route. Request resume again now that the capture track is live.
      const resume = context.state === 'running' ? session.resumed : context.resume();
      watch(session, 8_000, micError);
      await Promise.race([interrupted, Promise.all([
        resume.catch(() => { throw new Error(micError); }),
        context.audioWorklet.addModule(processorUrl).catch(() => {
          throw new Error('Не удалось запустить обработку микрофона. Обновите страницу и попробуйте снова.');
        }),
      ])]);
      if (context.state !== 'running') throw new Error(micError);
      if (retained) {
        clearTimeout(releaseTimer);
        session.model = retained;
        retained = null;
      } else {
        watch(session, 60_000, localModelError);
        let vosk;
        try { vosk = await Promise.race([interrupted, loadVosk()]); }
        catch (error) { throw error.name === 'AbortError' ? error : new Error(localModelError); }
        if (session !== current) return;
        const model = new vosk.Model(modelUrl, -2);
        session.model = model;
        bindModel(model);
        await Promise.race([interrupted, new Promise((resolve, reject) => {
          model.on('load', ({ result }) => result ? resolve() : reject(new Error(localModelError)));
        })]);
      }
      if (session !== current) return;
      session.processor = openProcessor(context);
      session.source = context.createMediaStreamSource(stream);
      resetSegment();
      session.processor.onprocessorerror = () => fail(session, 'Ошибка обработки звука.');
      let silentSamples = 0, reportedSilence = false;
      session.processor.port.onmessage = ({ data }) => {
        if (session !== current || data.epoch !== session.epoch) return;
        if (!data.pcm?.length) return;
        watch(session, 8_000, micError);
        if (!session.hasInput) {
          session.hasInput = true;
          onStatus('listening');
        }
        // A muted input may still deliver uninterrupted, digital-zero PCM.
        // Show that state without advancing the script or stopping a take.
        silentSamples = data.pcm.some(sample => sample !== 0) ? 0 : silentSamples + data.pcm.length;
        const quiet = silentSamples >= 4 * context.sampleRate;
        if (reportedSilence !== quiet) {
          reportedSilence = quiet;
          onStatus(quiet ? 'quiet' : 'listening');
        }
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
      onStatus('microphone');
      watch(session, 8_000, micError);
      session.source.connect(session.processor);
      session.processor.connect(context.destination);
      session.starting = false;
      context.onstatechange = () => {
        if (context.state !== 'running') fail(session, 'Обработка звука приостановлена. Нажмите кнопку голоса ещё раз.');
      };
    } catch (error) {
      if (current === session) stop();
      throw error;
    }
  }

  return { prepare, start, stop, resetSegment };
}
