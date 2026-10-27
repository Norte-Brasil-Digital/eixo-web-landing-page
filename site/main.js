const root = document.documentElement;
const header = document.querySelector('[data-header]');
const mobileCta = document.querySelector('.mobile-cta');
const hero = document.querySelector('.hero');
const contact = document.querySelector('#demonstracao');

root.classList.add('js');

const onScroll = () => header?.classList.toggle('is-scrolled', window.scrollY > 24);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

if ('IntersectionObserver' in window) {
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      revealer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el) => revealer.observe(el));

  // Barra fixa no celular: aparece depois do topo e some quando o formulário está na tela.
  const state = { heroVisible: true, contactVisible: false };
  const sync = () => mobileCta?.classList.toggle('is-visible', !state.heroVisible && !state.contactVisible);
  const watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === hero) state.heroVisible = entry.isIntersecting;
      if (entry.target === contact) state.contactVisible = entry.isIntersecting;
    }
    sync();
  }, { threshold: 0.05 });
  if (hero) watcher.observe(hero);
  if (contact) watcher.observe(contact);

  // Vídeo de demonstração: só baixa e toca quando aparece na tela (sem áudio); pausa ao sair.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const player = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }
  }, { threshold: 0.4 });
  if (!reduceMotion) document.querySelectorAll('video[data-autoplay]').forEach((v) => player.observe(v));
} else {
  document.querySelectorAll('.reveal').forEach((el) => el.classList.add('is-visible'));
  mobileCta?.classList.add('is-visible');
}
