(() => {
  'use strict';

  const config = window.__MARKETING_CONFIG__;
  const canvas = document.getElementById('stage');
  const recorderBridge = window.marketingRecorder;
  if (!config?.copy || !canvas || !recorderBridge?.finish) {
    throw new Error('Marketing video bootstrap data is incomplete.');
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  const { palette, copy } = config;
  const FONT = '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function easeOut(value) {
    const t = clamp(value);
    return 1 - (1 - t) ** 3;
  }

  function easeInOut(value) {
    const t = clamp(value);
    return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2;
  }

  function sceneAlpha(time, start, end, fade = 0.32) {
    return clamp((time - start) / fade) * clamp((end - time) / fade);
  }

  function roundRectPath(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function fillRoundRect(x, y, width, height, radius, color) {
    roundRectPath(x, y, width, height, radius);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function strokeRoundRect(x, y, width, height, radius, color, lineWidth = 2) {
    roundRectPath(x, y, width, height, radius);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  function text(value, x, y, size, weight = 400, color = palette.ink, align = 'left') {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  }

  function drawImageContain(image, x, y, width, height) {
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const targetWidth = image.naturalWidth * scale;
    const targetHeight = image.naturalHeight * scale;
    ctx.drawImage(image, x + (width - targetWidth) / 2, y + (height - targetHeight) / 2, targetWidth, targetHeight);
  }

  function drawImageCover(image, x, y, width, height) {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const sourceWidth = width / scale;
    const sourceHeight = height / scale;
    const sourceX = (image.naturalWidth - sourceWidth) / 2;
    const sourceY = (image.naturalHeight - sourceHeight) / 2;
    ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
  }

  function drawClippedContain(image, x, y, width, height, radius) {
    ctx.save();
    roundRectPath(x, y, width, height, radius);
    ctx.clip();
    ctx.fillStyle = palette.softCream;
    ctx.fillRect(x, y, width, height);
    drawImageContain(image, x, y, width, height);
    ctx.restore();
  }

  function drawPet(frames, time, x, y, width, height, speed = 6) {
    const index = Math.floor(time * speed) % frames.length;
    drawImageContain(frames[index], x, y, width, height);
  }

  function drawBackground(time) {
    ctx.fillStyle = palette.cream;
    ctx.fillRect(0, 0, config.width, config.height);
    ctx.fillStyle = palette.softCream;
    ctx.beginPath();
    ctx.arc(972, 132 + Math.sin(time * 0.8) * 12, 168, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(62, 1760 + Math.cos(time * 0.7) * 10, 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.cobalt;
    ctx.beginPath();
    ctx.arc(992, 76, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBadge(label, x, y, width, fill = palette.coral) {
    fillRoundRect(x, y, width, 62, 31, fill);
    text(label, x + width / 2, y + 42, 28, 700, palette.white, 'center');
  }

  function drawIntro(time, images) {
    const alpha = sceneAlpha(time, 0, 2.7, 0.35);
    if (alpha <= 0) return;
    const local = easeOut(time / 1.2);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, (1 - local) * 46);
    drawBadge(copy.shared.internalTest, 78, 106, 192);
    text(copy.shared.freeCustom, 78, 344, 92, 800);
    text(copy.shared.desktopPet, 78, 468, 92, 800, palette.coral);
    text(copy.video.valueLead, 82, 570, 42, 500, palette.muted);
    text(copy.video.valueTail, 82, 630, 42, 500, palette.muted);
    fillRoundRect(78, 720, 924, 112, 32, palette.softCream);
    text(copy.shared.featureList, 540, 790, 35, 700, palette.sage, 'center');
    const lift = easeOut(clamp((time - 0.35) / 1.1));
    drawPet(images.pets.baobao, time, 78, 1420 - lift * 190, 430, 466);
    drawPet(images.pets.feifei, time, 572, 1420 - lift * 190, 430, 466);
    ctx.restore();
  }

  function drawProof(time, images) {
    const alpha = sceneAlpha(time, 2.25, 6.15, 0.38);
    if (alpha <= 0) return;
    const local = easeInOut(clamp((time - 2.25) / 1));
    ctx.save();
    ctx.globalAlpha = alpha;
    drawBadge(copy.shared.realScreen, 78, 98, 236, palette.sage);
    text(copy.video.proofHeadline, 78, 246, 58, 800);
    const y = 326 + (1 - local) * 40;
    fillRoundRect(62, y, 956, 1084, 46, palette.white);
    strokeRoundRect(62, y, 956, 1084, 46, palette.line, 3);
    drawClippedContain(images.screenshot, 88, y + 28, 904, 1028, 32);
    drawPet(images.pets.baobao, time, 18, 1450, 330, 358);
    drawPet(images.pets.feifei, time, 734, 1448, 330, 358);
    text(copy.video.proofDisclaimer, 540, 1810, 24, 500, palette.muted, 'center');
    ctx.restore();
  }

  function featureCard(x, y, label, detail, image, accent) {
    fillRoundRect(x, y, 438, 312, 38, palette.white);
    strokeRoundRect(x, y, 438, 312, 38, palette.line, 2);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(x + 62, y + 62, 11, 0, Math.PI * 2);
    ctx.fill();
    text(label, x + 42, y + 124, 42, 800);
    text(detail, x + 42, y + 174, 24, 500, palette.muted);
    drawImageContain(image, x + 254, y + 136, 154, 150);
  }

  function drawFeatures(time, images) {
    const alpha = sceneAlpha(time, 5.7, 9.55, 0.38);
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    drawBadge(copy.video.interactionBadge, 78, 98, 216, palette.coral);
    text(copy.video.interactionLead, 78, 242, 62, 800);
    text(copy.video.interactionTail, 78, 320, 62, 800, palette.coral);
    featureCard(72, 398, copy.video.petTitle, copy.video.petDetail, images.pets.baobao[2], palette.coral);
    featureCard(570, 398, copy.video.feedTitle, copy.video.feedDetail, images.items['salmon-treat'], palette.sage);
    featureCard(72, 750, copy.video.toyTitle, copy.video.toyDetail, images.items['coral-yarn-ball'], palette.cobalt);
    featureCard(570, 750, copy.video.intimacyTitle, copy.video.intimacyDetail, images.items['cat-house'], palette.coral);
    fillRoundRect(72, 1136, 936, 148, 34, palette.softCream);
    text(copy.shared.featureList, 540, 1226, 35, 700, palette.sage, 'center');
    drawPet(images.pets.baobao, time, 68, 1370, 376, 408);
    drawPet(images.pets.feifei, time, 636, 1370, 376, 408);
    ctx.restore();
  }

  function processCard(number, y, title, detail, accent) {
    fillRoundRect(72, y, 936, 310, 42, palette.white);
    strokeRoundRect(72, y, 936, 310, 42, palette.line, 3);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(154, y + 94, 44, 0, Math.PI * 2);
    ctx.fill();
    text(String(number), 154, y + 108, 38, 800, palette.white, 'center');
    text(title, 228, y + 102, 47, 800);
    text(detail, 110, y + 202, 28, 500, palette.muted);
  }

  function drawParticipation(time, images) {
    const alpha = sceneAlpha(time, 9.05, 12.35, 0.35);
    if (alpha <= 0) return;
    const local = easeOut(clamp((time - 9.05) / 0.9));
    ctx.save();
    ctx.globalAlpha = alpha;
    drawBadge(copy.video.participationBadge, 78, 98, 184, palette.sage);
    text(copy.video.participationLead, 78, 248, 64, 800);
    text(copy.video.participationTail, 78, 328, 64, 800, palette.coral);
    ctx.translate((1 - local) * 36, 0);
    processCard(copy.portraitTwo.step1Number, 430, copy.video.photoTitle, copy.video.photoDetail, palette.coral);
    processCard(copy.portraitTwo.step2Number, 790, copy.video.feedbackTitle, copy.video.feedbackDetail, palette.sage);
    ctx.translate(-(1 - local) * 36, 0);
    fillRoundRect(72, 1160, 936, 146, 34, palette.softCream);
    text(copy.shared.status, 540, 1248, 29, 500, palette.muted, 'center');
    drawPet(images.pets.baobao, time, 76, 1390, 380, 412);
    drawPet(images.pets.feifei, time, 624, 1390, 380, 412);
    ctx.restore();
  }

  function drawClosing(time, images) {
    const alpha = sceneAlpha(time, 11.85, 14.2, 0.35);
    if (alpha <= 0) return;
    const local = easeOut(clamp((time - 11.85) / 0.8));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, (1 - local) * 34);
    drawBadge(copy.shared.internalTest, 78, 110, 192);
    text(copy.video.voluntaryShareLead, 78, 356, 82, 800);
    text(copy.video.voluntaryShareTail, 78, 462, 82, 800, palette.coral);
    fillRoundRect(78, 566, 924, 176, 38, palette.softCream);
    text(copy.video.closingParticipationLead, 540, 638, 31, 600, palette.ink, 'center');
    text(copy.video.closingParticipationTail, 540, 690, 31, 600, palette.ink, 'center');
    drawImageContain(images.items['teaser-wand'], 70, 832, 230, 420);
    drawImageContain(images.items['coral-yarn-ball'], 820, 900, 180, 188);
    drawPet(images.pets.baobao, time, 124, 1170, 390, 423);
    drawPet(images.pets.feifei, time, 566, 1170, 390, 423);
    text(copy.shared.offerFull, 540, 1728, 40, 800, palette.sage, 'center');
    text(copy.shared.status, 540, 1790, 24, 400, palette.muted, 'center');
    ctx.restore();
  }

  function drawFrame(time, images) {
    drawBackground(time);
    drawIntro(time, images);
    drawProof(time, images);
    drawFeatures(time, images);
    drawParticipation(time, images);
    drawClosing(time, images);
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('A required embedded marketing image could not be decoded.'));
      image.src = source;
    });
  }

  async function loadImages() {
    const screenshot = await loadImage(config.screenshot);
    const baobao = await Promise.all(config.pets.baobao.map(loadImage));
    const feifei = await Promise.all(config.pets.feifei.map(loadImage));
    const itemEntries = await Promise.all(
      Object.entries(config.items).map(async ([id, source]) => [id, await loadImage(source)]),
    );
    return { screenshot, pets: { baobao, feifei }, items: Object.fromEntries(itemEntries) };
  }

  function createRecorder(stream) {
    const candidates = [
      'video/webm;codecs=vp8',
      'video/webm',
      'video/webm;codecs=vp9',
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
    ];
    for (const mimeType of candidates) {
      if (!MediaRecorder.isTypeSupported(mimeType)) continue;
      try {
        return {
          recorder: new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 }),
          mimeType,
        };
      } catch {
        // Try the next explicitly allowlisted container/codec.
      }
    }
    throw new Error('This Electron/Chromium build supports none of the allowlisted MP4 or WebM MediaRecorder formats.');
  }

  function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))));
    }
    return btoa(chunks.join(''));
  }

  async function record(images) {
    if (canvas.width !== config.width || canvas.height !== config.height) {
      throw new Error(`Canvas dimensions must remain ${config.width}x${config.height}.`);
    }
    if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder !== 'function') {
      throw new Error('Canvas captureStream or MediaRecorder is unavailable.');
    }

    drawFrame(0, images);
    const stream = canvas.captureStream(0);
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack || typeof videoTrack.requestFrame !== 'function') {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('Manual canvas frame capture is unavailable.');
    }
    const { recorder, mimeType } = createRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve, reject) => {
      recorder.onerror = (event) => reject(event.error || new Error('MediaRecorder failed.'));
      recorder.onstop = resolve;
    });

    console.info(`recording-start ${mimeType}`);
    recorder.start(250);
    const start = performance.now();
    await new Promise((resolve, reject) => {
      const intervalMs = 1000 / config.fps;
      const timer = setInterval(() => {
        try {
          const elapsedMs = performance.now() - start;
          drawFrame(Math.min(elapsedMs, config.durationMs) / 1000, images);
          videoTrack.requestFrame();
          if (elapsedMs >= config.durationMs) {
            clearInterval(timer);
            resolve();
          }
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, intervalMs);
    });
    console.info('recording-stop-requested');
    recorder.requestData();
    recorder.stop();
    await stopped;
    console.info(`recording-stopped chunks=${chunks.length}`);
    for (const track of stream.getTracks()) track.stop();

    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) throw new Error('MediaRecorder returned an empty video.');
    console.info(`recording-blob bytes=${blob.size}`);
    const dataBase64 = arrayBufferToBase64(await blob.arrayBuffer());
    console.info(`recording-ipc bytes=${dataBase64.length}`);
    await recorderBridge.finish({
      mimeType,
      dataBase64,
      durationMs: config.durationMs,
      width: config.width,
      height: config.height,
      fps: config.fps,
    });
  }

  async function main() {
    console.info('images-loading');
    const images = await loadImages();
    console.info('images-loaded');
    await record(images);
  }

  main().catch(async (error) => {
    try {
      await recorderBridge.finish({ error: error?.stack || error?.message || String(error) });
    } catch {
      // The parent process timeout remains the final failure path if IPC is unavailable.
    }
  });
})();
