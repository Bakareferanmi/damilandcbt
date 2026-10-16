// Admin shell: checks the admin is logged in, then wraps the page in the sidebar layout.
// Each admin page loads this with data-page="overview|students|questions|results".
(function () {
  const P = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const icons = {
    overview: P('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>'),
    students: P('<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/><path d="M16 4.5a4 4 0 0 1 0 7"/><path d="M19 14.5a6 6 0 0 1 3 5.5v1"/>'),
    questions: P('<path d="M4 4h16v13H8l-4 4z"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5"/><path d="M12 15h.01"/>'),
    results: P('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
    logout: P('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
    settings: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    menu: P('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  };
  const items = [['overview', '/insights', 'Overview'], ['students', '/students', 'Students'], ['questions', '/questions', 'Questions'], ['results', '/results', 'Results'], ['settings', '/settings', 'Settings']];
  const script = document.currentScript;
  const page = script.dataset.page;
  const title = script.dataset.title || '';

  fetch('/api/me').then((r) => r.ok ? r.json() : null).then((me) => {
    if (!me || me.role !== 'admin') { location.replace('/admin'); return; }
    const kids = [...document.body.childNodes].filter((n) => n !== script);
    const app = document.createElement('div');
    app.className = 'app';
    app.innerHTML = `
      <aside class="side" aria-label="Main menu">
        <div class="brand"><img src="/logo.png" alt=""><div><b>Damiland</b><span>CBT admin</span></div></div>
        <nav class="nav">${items.map(([k, href, label]) => `<a href="${href}" ${k === page ? 'aria-current="page"' : ''}>${icons[k]}${label}</a>`).join('')}</nav>
        <div class="who" title="${me.email}">${me.email}</div>
        <button class="logout" id="shell-logout">${icons.logout}Log out</button>
      </aside>
      <div class="scrim"></div>
      <div class="main">
        <div class="pagehead"><button class="menu" id="shell-menu" aria-label="Open menu">${icons.menu}</button><h1>${title}</h1></div>
        <div class="content" id="shell-content"></div>
      </div>`;
    const content = app.querySelector('#shell-content');
    kids.forEach((n) => content.appendChild(n));
    document.body.classList.add('shell');
    document.body.appendChild(app);
    document.body.appendChild(script);
    app.querySelector('#shell-menu').onclick = () => app.classList.toggle('open');
    app.querySelector('.scrim').onclick = () => app.classList.remove('open');
    app.querySelector('#shell-logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/admin'; };
    // Session switcher: which academic session the pages show.
    fetch('/api/admin/sessions').then((r) => r.json()).then((d) => {
      if (!d.sessions) return;
      const box = document.createElement('label');
      box.className = 'sessbox';
      box.innerHTML = `<span>Session</span><select id="shell-session" aria-label="Academic session">${d.sessions.map((x) => `<option value="${x.id}" ${x.id === d.viewing ? 'selected' : ''}>${x.name}${x.current ? ' (current)' : ''}</option>`).join('')}</select>`;
      app.querySelector('.nav').before(box);
      box.querySelector('select').onchange = async (e) => {
        await fetch('/api/admin/sessions/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: Number(e.target.value) }) });
        location.reload();
      };
      if (d.viewing !== d.current) {
        const name = d.sessions.find((x) => x.id === d.viewing).name;
        const bar = document.createElement('div');
        bar.className = 'pastbar';
        bar.textContent = `You are viewing the ${name} session. It is read-only (past session).`;
        content.before(bar);
        document.body.classList.add('past');
      }
    }).catch(() => {});
    document.dispatchEvent(new Event('shell-ready'));
  }).catch(() => location.replace('/admin'));
})();
