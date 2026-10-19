'use strict';
// Live camera and microphone checks. Video and sound are analysed on the candidate's own device and are never recorded,
// stored or uploaded. Only short alert codes are sent ("no_face", "loud_noise", ...). The candidate sees their own camera
// in a small window so it is clear what is switched on.
(function () {
  const NT = window.NT;
  const MON = (NT.monitor = {});
  const CHECK_MS = 2000, FACE_MISS = 3, MULTI = 2, DARK_LUMA = 14, DARK_N = 3, LOUD_RMS = 0.22, LOUD_MS = 3000, REPEAT_MS = 30000;

  MON.supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  // Asks for permission. Throws an Error with a plain message the candidate can act on.
  MON.request = async function () {
    if (!MON.supported()) throw new Error('This browser cannot use the camera. Open the test in a current version of Chrome, Edge, Safari or Firefox on a phone or laptop.');
    try { return await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: true }); }
    catch (e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') throw new Error('Camera and microphone access was blocked. Allow both in the address bar or browser settings, then try again.');
      if (n === 'NotFoundError' || n === 'OverconstrainedError') throw new Error('No camera or microphone was found. Connect one and try again.');
      if (n === 'NotReadableError') throw new Error('Another app is using the camera or microphone. Close it and try again.');
      throw new Error('The camera and microphone could not be started.');
    }
  };

  // stream: from request(). report(code): called with an alert code. Returns { stop() }.
  MON.run = function (stream, report, mount) {
    const h = NT.h;
    const video = h('video', { autoplay: true, muted: true, playsinline: true, 'aria-label': 'Your camera preview', class: 'cam-video' });
    video.muted = true; video.srcObject = stream;
    const dot = h('span', { class: 'cam-dot', 'aria-hidden': 'true' });
    const label = h('span', { class: 'cam-label', text: 'Camera and mic on · not recorded' });
    const box = h('div', { class: 'cam-box', role: 'status' }, video, h('div', { class: 'cam-cap' }, dot, label));
    (mount || document.body).append(box);
    video.play().catch(() => {});

    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48; const cx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'FaceDetector' in window ? (() => { try { return new window.FaceDetector({ fastMode: true, maxDetectedFaces: 3 }); } catch { return null; } })() : null;
    const last = {}; let dark = 0, noFace = 0, multi = 0, loudSince = 0, stopped = false, lostSent = false;
    const send = code => { const now = Date.now(); if (stopped || (last[code] && now - last[code] < REPEAT_MS)) return; last[code] = now; try { report(code); } catch { /* ignore */ } };

    // lost devices count as leaving the test (the server applies the lock mode)
    const lost = code => { if (lostSent || stopped) return; lostSent = true; label.textContent = 'Camera or mic is off'; box.classList.add('bad'); try { report(code); } catch { /* ignore */ } };
    stream.getVideoTracks().forEach(t => { t.addEventListener('ended', () => lost('camera_lost')); });
    stream.getAudioTracks().forEach(t => { t.addEventListener('ended', () => lost('mic_lost')); });
    if (!detector) send('face_check_unavailable');
    send('camera_on');

    // sound level, measured only (no audio is kept)
    let ac = null, an = null, buf = null;
    try { const AC = window.AudioContext || window.webkitAudioContext; ac = new AC(); const src = ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks())); an = ac.createAnalyser(); an.fftSize = 1024; src.connect(an); buf = new Float32Array(an.fftSize); } catch { an = null; }
    const soundTimer = setInterval(() => {
      if (!an || stopped) return; an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; const rms = Math.sqrt(s / buf.length);
      if (rms > LOUD_RMS) { if (!loudSince) loudSince = Date.now(); else if (Date.now() - loudSince >= LOUD_MS) { send('loud_noise'); loudSince = 0; } } else loudSince = 0;
    }, 500);

    const tick = async () => {
      if (stopped) return;
      const vt = stream.getVideoTracks()[0], at = stream.getAudioTracks()[0];
      if (vt && vt.readyState === 'ended') return lost('camera_lost');
      if (at && at.readyState === 'ended') return lost('mic_lost');
      if (video.readyState < 2) return;
      try {
        cx.drawImage(video, 0, 0, 64, 48); const d = cx.getImageData(0, 0, 64, 48).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        const luma = sum / (d.length / 4); dark = luma < DARK_LUMA ? dark + 1 : 0; if (dark >= DARK_N) { send('camera_covered'); dark = 0; }
        if (detector && luma >= DARK_LUMA) {
          const faces = await detector.detect(video);
          noFace = faces.length === 0 ? noFace + 1 : 0; multi = faces.length > 1 ? multi + 1 : 0;
          if (noFace >= FACE_MISS) { send('no_face'); noFace = 0; } if (multi >= MULTI) { send('multiple_faces'); multi = 0; }
        }
      } catch { /* a frame that cannot be read is skipped */ }
    };
    const timer = setInterval(tick, CHECK_MS);

    return {
      stop() { if (stopped) return; stopped = true; clearInterval(timer); clearInterval(soundTimer); stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } }); try { ac && ac.close(); } catch { /* ignore */ } video.srcObject = null; box.remove(); },
    };
  };
})();
