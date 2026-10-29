// Opening animation ("flow"): each letter flows in from the left, slightly blurred,
// one after another; a light sweeps across the title; then the start button rises.
// Leaving streams the letters out to the right while the glow swells.

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function split(el) {
  const text = el.textContent;
  el.setAttribute('aria-label', text);
  el.innerHTML = [...text].map((c) => (c === ' ' ? '<span class="space"></span>' : `<span class="ch" aria-hidden="true">${c}</span>`)).join('');
  return [...el.querySelectorAll('.ch')];
}

// Each title letter carries its own slice of one shared gradient, so the colour sweep
// stays continuous while the letters move independently.
function paintGradient(title) {
  const w = title.getBoundingClientRect().width;
  title.querySelectorAll('.ch').forEach((c) => {
    c.style.backgroundSize = `${w}px 100%`;
    c.style.backgroundPosition = `${-c.offsetLeft}px 0`;
  });
}

export function playIntro(root) {
  const eyebrow = root.querySelector('.eyebrow');
  const title = root.querySelector('.hero-title');
  const lines = [...root.querySelectorAll('.hero-sub .line')];
  const glow = root.querySelector('.intro-glow');
  const sheen = root.querySelector('.sheen');
  const button = root.querySelector('#introStart');

  const titleChars = split(title);
  title.classList.add('split');
  const eyebrowChars = split(eyebrow);
  const lineChars = lines.map(split);
  root.classList.add('ready');
  const repaint = () => paintGradient(title);
  // Measure after fonts load so the gradient slices line up with the real glyphs.
  (document.fonts?.ready || Promise.resolve()).then(repaint);
  repaint();
  addEventListener('resize', repaint);
  if (reduced()) return;

  glow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1600, easing: EASE, fill: 'backwards' });
  eyebrowChars.forEach((c, i) => c.animate(
    [{ opacity: 0, transform: 'translateX(-14px)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 500, delay: 150 + i * 28, easing: EASE, fill: 'backwards' }));
  let t = 420;
  titleChars.forEach((c, i) => c.animate(
    [{ opacity: 0, transform: 'translateX(-0.55em) scale(.96)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 720, delay: t + i * 52, easing: EASE, fill: 'backwards' }));
  t += titleChars.length * 52 + 260;
  lineChars.forEach((chars, li) => chars.forEach((c, i) => c.animate(
    [{ opacity: 0, transform: 'translateX(-10px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 520, delay: t + li * 260 + i * 24, easing: EASE, fill: 'backwards' })));
  sheen.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(120%)' }], { duration: 1100, delay: t + 300, easing: 'ease-in-out', fill: 'both' });
  button.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: t + 900, easing: EASE, fill: 'backwards' });
}

// Resolves once the intro is gone.
export function leaveIntro(root) {
  return new Promise((resolve) => {
    const finish = () => { root.remove(); resolve(); };
    if (reduced()) { finish(); return; }
    root.style.pointerEvents = 'none';
    // Cancel any entrance still running so the exit starts from the visible state.
    root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    const chars = [...root.querySelectorAll('.ch')];
    chars.forEach((c, i) => c.animate(
      [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateX(40px)', filter: 'blur(6px)' }],
      { duration: 420, delay: i * 12, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }));
    root.querySelector('#introStart').animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
    root.querySelector('.intro-glow').animate(
      [{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(1.8)', opacity: 0 }],
      { duration: 900, delay: 150, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    const lettersDone = Math.min(chars.length * 12, 600) + 420;
    // Then the black backdrop fades away to reveal the app.
    root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, delay: lettersDone - 150, easing: 'ease-out', fill: 'forwards' })
      .finished.then(finish, finish);
  });
}

// Runs on its own as soon as this small module loads (it is included before main.js),
// so the animation never waits for the 3D library that main.js pulls in.
const root = document.getElementById('intro');
if (root) {
  playIntro(root);
  root.querySelector('#introStart').addEventListener('click', () => leaveIntro(root), { once: true });
}
