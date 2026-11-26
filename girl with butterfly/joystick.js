const DEAD_ZONE = 0.12;

/**
 * Minimal bottom-right virtual joystick. The normalized vector uses screen
 * semantics: x is right-positive, y is forward-positive. Releasing the stick
 * always recenters it and emits a zero vector.
 */
export function createJoystick() {
  const layer = document.createElement('div');
  layer.className = 'virtual-joystick';
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', '移动摇杆');

  const base = document.createElement('div');
  base.className = 'virtual-joystick__base';
  const knob = document.createElement('div');
  knob.className = 'virtual-joystick__knob';
  base.appendChild(knob);
  layer.appendChild(base);

  const host = document.querySelector('#stage') ?? document.body;
  host.appendChild(layer);

  const state = {
    x: 0,
    y: 0,
    forward: 0,
    right: 0,
    magnitude: 0,
    active: false,
    direction: 'idle',
  };

  let pointerId = null;
  let maxOffset = 1;

  const emit = () => {
    const detail = { ...state };
    window.dispatchEvent(new CustomEvent('joystickmove', { detail }));
    window.pondJoystick = api;
  };

  const applyKnob = (px, py) => {
    const length = Math.hypot(px, py);
    if (length > maxOffset) {
      px = (px / length) * maxOffset;
      py = (py / length) * maxOffset;
    }
    knob.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  };

  const updateFromEvent = (event) => {
    const rect = base.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const knobSize = knob.getBoundingClientRect().width;
    maxOffset = Math.max(1, rect.width / 2 - knobSize / 2 - 6);

    let dx = event.clientX - centerX;
    let dy = event.clientY - centerY;
    const length = Math.hypot(dx, dy);
    if (length > maxOffset) {
      dx = (dx / length) * maxOffset;
      dy = (dy / length) * maxOffset;
    }
    applyKnob(dx, dy);

    const x = dx / maxOffset;
    const rawY = -dy / maxOffset;
    const magnitude = Math.min(1, Math.hypot(x, rawY));
    if (magnitude < DEAD_ZONE) {
      state.x = 0;
      state.y = 0;
      state.forward = 0;
      state.right = 0;
      state.magnitude = 0;
      state.direction = 'idle';
    } else {
      state.x = x;
      state.y = rawY;
      state.forward = rawY;
      state.right = x;
      state.magnitude = magnitude;
      const horizontal = Math.abs(x) > 0.38 ? (x > 0 ? 'right' : 'left') : '';
      const vertical = Math.abs(rawY) > 0.38 ? (rawY > 0 ? 'forward' : 'backward') : '';
      state.direction = [vertical, horizontal].filter(Boolean).join('-') || 'idle';
    }
    state.active = true;
    emit();
  };

  const onWindowMove = (event) => {
    if (event.pointerId !== pointerId) return;
    event.preventDefault();
    updateFromEvent(event);
  };

  const cleanupDrag = () => {
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  };

  function release(event) {
    if (event && pointerId !== null && event.pointerId !== pointerId) return;
    if (pointerId === null) return;
    pointerId = null;
    cleanupDrag();
    state.x = 0;
    state.y = 0;
    state.forward = 0;
    state.right = 0;
    state.magnitude = 0;
    state.active = false;
    state.direction = 'idle';
    layer.classList.remove('is-active');
    knob.style.transform = 'translate3d(0, 0, 0)';
    emit();
  }

  base.addEventListener('pointerdown', (event) => {
    if (pointerId !== null) return;
    event.preventDefault();
    event.stopPropagation();
    pointerId = event.pointerId;
    layer.classList.add('is-active');
    window.addEventListener('pointermove', onWindowMove, { passive: false });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    updateFromEvent(event);
  });

  window.addEventListener('blur', () => release());

  const api = { state, element: layer };

  // Initialize the global handle before any input so consumers can wire up
  // immediately, then publish through joystickmove events as the vector moves.
  window.pondJoystick = api;
  return api;
}
