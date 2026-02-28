import confetti from 'canvas-confetti';

export function fireProfitConfetti() {
  confetti({
    particleCount: 100,
    spread: 70,
    origin: { y: 0.6 },
    colors: ['#10b981', '#34d399', '#6ee7b7', '#059669', '#047857'],
  });

  setTimeout(() => {
    confetti({
      particleCount: 50,
      angle: 60,
      spread: 55,
      origin: { x: 0 },
      colors: ['#10b981', '#34d399', '#fbbf24'],
    });
    confetti({
      particleCount: 50,
      angle: 120,
      spread: 55,
      origin: { x: 1 },
      colors: ['#10b981', '#34d399', '#fbbf24'],
    });
  }, 200);
}

export function fireLossAnimation() {
  const el = document.getElementById('trade-result-card');
  if (el) {
    el.classList.add('animate-loss-shake');
    setTimeout(() => el.classList.remove('animate-loss-shake'), 600);
  }
}
