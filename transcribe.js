// Local speech-to-text for WhatsApp voice messages: ffmpeg decodes the
// Opus/OGG audio, then Whisper (via transformers.js) transcribes it on this PC.
// The model downloads once from Hugging Face on first use, then runs offline.
const { spawn } = require('child_process');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

// whisper-base is fast on CPU and handles English/French/Arabic reasonably;
// set CLAUDE_WA_WHISPER_MODEL=Xenova/whisper-small for better accuracy (slower, ~500 MB)
const MODEL = process.env.CLAUDE_WA_WHISPER_MODEL || 'Xenova/whisper-base';

let asrPromise = null;

function getAsr() {
  // transformers.js is ESM-only, hence the dynamic import
  asrPromise ??= import('@huggingface/transformers').then(({ pipeline }) =>
    pipeline('automatic-speech-recognition', MODEL),
  );
  return asrPromise;
}

// Whisper wants 16 kHz mono float samples.
// ffmpeg picks the format from the file's contents, not its name, so a crafted "audio" file from a
// stranger could be a playlist or script that makes it read local files. For untrusted audio the
// input comes through stdin with only the pipe protocol allowed, and is capped at 2 minutes.
function decode(file, untrusted = false) {
  return new Promise((resolve, reject) => {
    const input = untrusted ? ['-nostdin', '-protocol_whitelist', 'pipe', '-i', 'pipe:0'] : ['-nostdin', '-i', file];
    const limit = untrusted ? ['-t', '120'] : [];
    const ff = spawn(ffmpegPath, [...input, ...limit, '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'], {
      windowsHide: true,
      stdio: [untrusted ? 'pipe' : 'ignore', 'pipe', 'ignore'],
    });
    if (untrusted) {
      ff.stdin.on('error', () => {}); // ffmpeg may stop reading early (that's the -t limit working)
      fs.createReadStream(file).on('error', () => ff.stdin.end()).pipe(ff.stdin);
    }
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    });
  });
}

// transformers.js doesn't auto-detect the language (it falls back to English),
// so the spoken language is passed in, e.g. 'english', 'french', 'arabic'
async function transcribe(file, language = 'english', { untrusted = false } = {}) {
  const [audio, asr] = await Promise.all([decode(file, untrusted), getAsr()]);
  const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', language });
  return (out.text || '').trim();
}

module.exports = { transcribe };
