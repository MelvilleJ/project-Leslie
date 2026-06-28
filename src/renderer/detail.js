'use strict';

// Detail window renderer. Two modes:
//   text — streams the model's detailed answer into #content
//   web  — loads a URL / search results into the <webview>
// Driven entirely by the main process via window.detail.*

const title = document.getElementById('title');
const back = document.getElementById('back');
const content = document.getElementById('content');
const web = document.getElementById('web');

function showText() {
  web.classList.add('hidden');
  back.classList.add('hidden');
  content.classList.remove('hidden');
}

function showWeb() {
  content.classList.add('hidden');
  web.classList.remove('hidden');
  back.classList.remove('hidden');
}

// Auto-scroll only when already near the bottom, so reading isn't interrupted.
function autoScroll() {
  const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 60;
  if (nearBottom) content.scrollTop = content.scrollHeight;
}

// --- Text mode (detailed answers) ------------------------------------------
// The detailed answer is treated as Markdown: we buffer the raw text as it
// streams in and re-render it to HTML on each chunk.
let raw = '';

function renderContent() {
  content.innerHTML = window.markdown.render(raw);
}

window.detail.onBegin((data) => {
  showText();
  title.textContent = data.question ? `Details — ${data.question}` : 'Detailed response';
  raw = '';
  content.innerHTML = '';
  content.scrollTop = 0;
});

window.detail.onChunk((text) => {
  raw += text;
  renderContent();
  autoScroll();
});

window.detail.onEnd(() => {
  renderContent();
});

// --- Web mode (opened URL / search) ----------------------------------------
window.detail.onUrl((url) => {
  showWeb();
  title.textContent = url;
  web.src = url;
});

web.addEventListener('did-navigate', (e) => {
  if (e.url) title.textContent = e.url;
});
web.addEventListener('page-title-updated', (e) => {
  if (e.title) title.textContent = e.title;
});

back.addEventListener('click', () => {
  web.src = 'about:blank';
  showText();
});
