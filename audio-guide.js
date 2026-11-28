(() => {
  // Set this to false if the audio should keep playing when the guide is closed.
  const PAUSE_ON_CLOSE = true;
  const SCROLL_HOLD_MS = 2500;

  const dataElement = document.getElementById('audioGuideData');
  const trigger = document.querySelector('.scene-cursor');
  if (!dataElement || !trigger) return;

  let config;
  try {
    config = JSON.parse(dataElement.textContent);
  } catch (error) {
    console.warn('[Audio Guide] Invalid subtitle data.', error);
    return;
  }

  // Subtitle timings are sentence-level estimates. Replace the start/end values
  // in each page's #audioGuideData JSON with exact timestamps when available.
  const lines = Array.isArray(config.subtitles) ? config.subtitles : [];
  if (!lines.length) return;

  const modal = document.createElement('div');
  modal.className = 'audio-guide';
  modal.id = 'audioGuideModal';
  modal.setAttribute('aria-hidden', 'true');
  modal.style.setProperty('--ag-accent', config.accent || '#dfb56d');
  modal.style.setProperty('--ag-ink', config.ink || '#f6e8d0');
  modal.style.setProperty('--ag-panel', config.panel || 'rgba(20, 14, 10, 0.94)');
  modal.style.setProperty('--ag-line', config.line || 'rgba(244, 218, 174, 0.24)');
  modal.innerHTML = `
    <div class="audio-guide__backdrop" data-audio-guide-close></div>
    <section class="audio-guide__panel" role="dialog" aria-modal="true" aria-labelledby="audioGuideTitle" tabindex="-1">
      <header class="audio-guide__header">
        <h2 class="audio-guide__title" id="audioGuideTitle">Audio Guide</h2>
        <button class="audio-guide__close" type="button" aria-label="Close Audio Guide" data-audio-guide-close>&times;</button>
      </header>
      <div class="audio-guide__lyrics" id="audioGuideLyrics" aria-live="polite"></div>
      <footer class="audio-guide__controls">
        <button class="audio-guide__play" type="button" aria-label="Play">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path class="audio-guide__icon-play" d="M8 5v14l11-7z"/>
            <path class="audio-guide__icon-pause" d="M7 5h4v14H7zm6 0h4v14h-4z"/>
          </svg>
        </button>
        <input class="audio-guide__progress" type="range" min="0" max="0" step="0.01" value="0" aria-label="Seek audio guide">
        <span class="audio-guide__time">0:00 / 0:00</span>
      </footer>
      <audio class="audio-guide__audio" preload="metadata"></audio>
    </section>
  `;
  document.body.appendChild(modal);

  const panel = modal.querySelector('.audio-guide__panel');
  const lyrics = modal.querySelector('.audio-guide__lyrics');
  const playButton = modal.querySelector('.audio-guide__play');
  const progress = modal.querySelector('.audio-guide__progress');
  const timeLabel = modal.querySelector('.audio-guide__time');
  const audio = modal.querySelector('.audio-guide__audio');
  audio.src = config.audio;

  const lineElements = lines.map((line, index) => {
    const element = document.createElement('p');
    element.className = 'audio-guide__line';
    element.textContent = line.text;
    element.dataset.index = String(index);
    element.addEventListener('click', () => {
      const seek = () => {
        const limit = Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.max(0, audio.duration - 0.05)
          : line.start + 0.01;
        try {
          audio.currentTime = Math.min(line.start + 0.01, limit);
        } catch (error) {
          // Metadata may still be loading; retry once it is available.
          audio.addEventListener('loadedmetadata', () => {
            audio.currentTime = Math.min(line.start + 0.01, Math.max(0, audio.duration - 0.05));
          }, { once: true });
        }
        setActive(index, true);
        scrollToLine(index, true);
        if (audio.paused) {
          const attempt = audio.play();
          if (attempt && attempt.catch) attempt.catch(() => {});
        }
      };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    });
    lyrics.appendChild(element);
    return element;
  });

  let activeIndex = -1;
  let lastFocus = null;
  let scrollHoldUntil = 0;

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };

  const findActiveLine = (time) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (time >= lines[i].start) return i;
    }
    return -1;
  };

  const scrollToLine = (index, force = false) => {
    if (index < 0 || index >= lineElements.length) return;
    if (!force && performance.now() < scrollHoldUntil) return;
    const element = lineElements[index];
    const target = element.offsetTop - lyrics.clientHeight * 0.42 + element.offsetHeight * 0.5;
    const top = Math.max(0, target);
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (typeof lyrics.scrollTo === 'function') {
      lyrics.scrollTo({ top, behavior });
    } else {
      lyrics.scrollTop = top;
    }
  };

  const setActive = (index, scroll = false) => {
    if (index === activeIndex) return;
    activeIndex = index;
    lineElements.forEach((element, i) => {
      element.classList.toggle('is-active', i === index);
      element.classList.toggle('is-past', index >= 0 && i < index);
      if (i === index) element.setAttribute('aria-current', 'true');
      else element.removeAttribute('aria-current');
    });
    if (scroll && index >= 0) scrollToLine(index, false);
  };

  const updateFromAudio = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    progress.max = duration || 0;
    if (duration > 0) progress.value = Math.min(current, duration);
    progress.style.setProperty('--ag-progress', `${duration > 0 ? Math.min(100, (current / duration) * 100) : 0}%`);
    timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    setActive(findActiveLine(current), true);
  };

  const setPlaying = (playing) => {
    playButton.classList.toggle('is-playing', playing);
    playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  const togglePlay = () => {
    if (audio.paused) {
      const attempt = audio.play();
      if (attempt && attempt.catch) attempt.catch(() => {});
    } else {
      audio.pause();
    }
  };

  const open = () => {
    lastFocus = document.activeElement;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('audio-guide-open');
    panel.focus({ preventScroll: true });
    // Ask for metadata only after the user opens the guide, so the page load
    // stays light and the duration appears as soon as the file is available.
    try {
      if (audio.readyState === 0) audio.load();
    } catch (error) {
      // The browser may defer loading until play is pressed; the controls
      // still work and metadata will arrive with the first play attempt.
    }
    updateFromAudio();
    if (activeIndex >= 0) scrollToLine(activeIndex, true);
  };

  const close = () => {
    if (!modal.classList.contains('is-open')) return;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('audio-guide-open');
    // Closing behaviour: keep true to pause the guide when the window closes.
    if (PAUSE_ON_CLOSE) audio.pause();
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus({ preventScroll: true });
    }
  };

  trigger.setAttribute('role', 'button');
  trigger.setAttribute('tabindex', '0');
  trigger.setAttribute('aria-label', 'Open Audio Guide');
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.style.pointerEvents = 'auto';
  trigger.style.cursor = 'pointer';
  trigger.style.touchAction = 'manipulation';
  trigger.addEventListener('click', open);
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      event.stopPropagation();
      open();
    }
  });

  modal.querySelectorAll('[data-audio-guide-close]').forEach((element) => {
    element.addEventListener('click', close);
  });
  playButton.addEventListener('click', togglePlay);

  progress.addEventListener('input', () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Number(progress.value);
    updateFromAudio();
  });

  ['wheel', 'touchstart', 'pointerdown'].forEach((type) => {
    lyrics.addEventListener(type, () => {
      scrollHoldUntil = performance.now() + SCROLL_HOLD_MS;
    }, { passive: true });
  });

  audio.addEventListener('loadedmetadata', updateFromAudio);
  audio.addEventListener('durationchange', updateFromAudio);
  audio.addEventListener('timeupdate', updateFromAudio);
  audio.addEventListener('seeked', updateFromAudio);
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => setPlaying(false));

  document.addEventListener('keydown', (event) => {
    if (!modal.classList.contains('is-open')) return;
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.code !== 'Space') return;
    const active = document.activeElement;
    const tag = active && active.tagName;
    if (active && (active.isContentEditable || ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(tag))) {
      return;
    }
    event.preventDefault();
    togglePlay();
  });

  setPlaying(false);
  updateFromAudio();
})();
