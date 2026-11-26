import * as THREE from 'three';

/**
 * A small, text-free pick-up affordance anchored beside the transparent
 * umbrella. It is a DOM overlay so it stays crisp and never occludes input.
 */
const ICONS = {
  hand: `
    <g transform="rotate(180 12 12)">
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
    </g>`,
  umbrella: `
    <path d="M4.2 11a7.8 7.8 0 0 1 15.6 0Z"/>
    <path d="M12 11v7a2 2 0 0 0 4 0"/>`,
  drop: `
    <path d="M12 3.2C9.5 7 6.7 10.2 6.7 13.6a5.3 5.3 0 0 0 10.6 0C17.3 10.2 14.5 7 12 3.2Z"/>
    <path d="M9.3 14.1a2.7 2.7 0 0 0 2.7 2.2"/>`,
};

export function createPickupPrompt({
  anchor,
  camera,
  onPickup = null,
  icon = 'hand',
  interactive = true,
}) {
  const element = document.createElement('div');
  element.className = 'umbrella-pickup';
  if (icon === 'umbrella') element.classList.add('umbrella-pickup--umbrella');
  if (icon === 'drop') element.classList.add('umbrella-pickup--water');
  if (!interactive) element.classList.add('umbrella-pickup--static');
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = `
    <span class="umbrella-pickup__ring"></span>
    <svg class="umbrella-pickup__icon" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.45" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      ${ICONS[icon] ?? ICONS.hand}
    </svg>`;
  (document.querySelector('#stage') ?? document.body).appendChild(element);

  const projected = new THREE.Vector3();
  let visible = false;
  let locked = false;
  let anchorPoint = anchor.clone();

  const setAnchor = (next) => {
    anchorPoint.copy(next);
  };

  const setVisible = (next) => {
    if (locked) next = false;
    if (visible === next) return;
    visible = next;
    element.classList.toggle('is-visible', visible);
  };

  const disable = () => {
    locked = true;
    setVisible(false);
    element.remove();
  };

  const pickUp = (event) => {
    if (locked || !visible) return;
    event.preventDefault();
    event.stopPropagation();
    locked = true;
    visible = false;
    element.classList.remove('is-visible');
    element.style.pointerEvents = 'none';
    onPickup?.();
  };

  if (interactive) {
    element.addEventListener('pointerdown', (event) => {
      if (!visible) return;
      event.preventDefault();
      event.stopPropagation();
    });
    element.addEventListener('click', pickUp);
  }

  const update = () => {
    if (!visible) return;
    projected.copy(anchorPoint).project(camera);
    if (projected.z < -1 || projected.z > 1) {
      element.style.opacity = '0';
      return;
    }
    element.style.opacity = '';
    const width = window.innerWidth;
    const height = window.innerHeight;
    const x = Math.min(width - 34, Math.max(34, (projected.x * 0.5 + 0.5) * width + 22));
    const y = Math.min(height - 34, Math.max(34, (-projected.y * 0.5 + 0.5) * height - 38));
    element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
  };

  return { element, setVisible, setAnchor, update, disable, isLocked: () => locked };
}
